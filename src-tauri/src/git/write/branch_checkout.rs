//! Branch checkout and remote-tracking checkout writes.

use crate::git::types::OperationKind;
use crate::redact::redact_secrets;

use super::branches::{ref_exists, resolve_rev};
use super::cli::{run_git, run_git_with_input};
use super::error::WriteError;
use super::head::{current_branch, run_switch, switch_branch, switch_detached};
use super::history::fast_forward_branch_at_locked;
use super::operands::ensure_operand;

/// What [`checkout`] switches to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckoutMode {
    /// `target` names an existing local branch.
    Branch,
    /// `target` is a revision to detach `HEAD` at.
    Detached,
}

impl CheckoutMode {
    /// The mode the IPC `detached` flag names.
    pub fn from_detached(detached: bool) -> Self {
        if detached {
            Self::Detached
        } else {
            Self::Branch
        }
    }
}

/// Switch to an existing local branch or detach at an explicit revision.
/// `mode` is part of the IPC intent: one-argument `git checkout <target>` is
/// deliberately forbidden because a stale branch can be reinterpreted as a
/// pathspec and silently restore a same-named tracked file.
///
/// Returns the redacted output of the quiet switch: hook output and warnings,
/// empty when there were none.
pub fn checkout(repo: &str, target: &str, mode: CheckoutMode) -> Result<String, String> {
    let _index_guard = super::index_lock::lock_index_writes(repo)?;
    let output = match mode {
        CheckoutMode::Branch => switch_branch(repo, target),
        CheckoutMode::Detached => switch_detached(repo, target),
    }?;
    Ok(redact_secrets(&output))
}

/// Check out the local counterpart of an existing remote-tracking ref. Create
/// it with tracking when missing; when it already exists, bring it up to the
/// remote tip and check it out. Patch-equivalent sibling commits (same parents
/// and tree) are aligned atomically; all other divergence is refused. Active
/// merge/sequencer operations are rejected before checkout can disturb their
/// state.
///
/// The ref moves *before* the switch, so the working tree changes once,
/// straight to the final commit: `post-checkout` runs once against the final
/// tree and `post-merge` never runs. A branch that is already checked out is
/// updated in place without a no-op switch. Returns the redacted hook/warning
/// output of whichever git command touched the working tree.
pub fn checkout_remote_branch(
    repo: &str,
    remote: &str,
    branch: &str,
) -> Result<String, WriteError> {
    let _index_guard = super::index_lock::lock_index_writes(repo)?;
    ensure_operand(remote)?;
    ensure_operand(branch)?;
    ensure_no_operation_in_progress(repo)?;
    let remote_ref = format!("refs/remotes/{remote}/{branch}");
    let local_ref = format!("refs/heads/{branch}");
    if !ref_exists(repo, &local_ref) {
        let output = run_switch(repo, &["--track", "-c", branch, "--", &remote_ref])?;
        return Ok(redact_secrets(&output));
    }

    // Classify before anything moves: genuine divergence must not change HEAD
    // or the local ref. The oids it captures are the compare-and-swap
    // preconditions for every write below, so a ref that moves afterwards
    // fails the write instead of being silently skipped.
    let update = classify_remote_checkout(repo, &local_ref, &remote_ref)?;
    let classified_target = update.target_oid().unwrap_or_default().to_string();

    if current_branch(repo).as_deref() == Some(branch) {
        let output = match update {
            RemoteCheckoutUpdate::UpToDate => Ok(String::new()),
            RemoteCheckoutUpdate::FastForward {
                local_oid,
                target_oid,
            } => fast_forward_branch_at_locked(repo, branch, &local_oid, &target_oid),
            RemoteCheckoutUpdate::AlignEquivalentSibling {
                local_oid,
                target_oid,
            } => align_equivalent_sibling(repo, &local_ref, &remote_ref, &local_oid, &target_oid)
                .map(|_| String::new()),
        }
        .map_err(|error| {
            format!("{branch} is checked out, but it couldn't be updated to {remote_ref}: {error}")
        })?;
        return Ok(redact_secrets(&output));
    }

    // Git refuses to switch to a branch another worktree holds, including one
    // whose directory is missing (prunable) and one paused in a rebase or
    // bisect of it. Refuse first, so the ref isn't moved underneath that
    // worktree for a switch that then fails.
    let listed = super::worktrees::worktrees(repo)?;
    if let Some(claim) = super::worktrees::branch_claim(repo, branch, &listed)? {
        return Err(WriteError::Git(format!(
            "{branch} is {}, so it can't be checked out here.",
            claim.describe()
        )));
    }

    // Not checked out anywhere: moving the ref has no working-tree side
    // effects. If the switch below is then refused (dirty files), HEAD stays
    // put and the branch is simply already up to date. A background fetch can
    // move the remote ref after classification; reclassify once and retry so
    // that race doesn't surface as a ref-lock error.
    if let Err(error) = advance_local_branch(repo, &local_ref, &remote_ref, update) {
        if resolve_rev(repo, &remote_ref).ok().as_deref() == Some(classified_target.as_str()) {
            return Err(WriteError::Git(error));
        }
        let update = classify_remote_checkout(repo, &local_ref, &remote_ref)?;
        advance_local_branch(repo, &local_ref, &remote_ref, update)
            .map_err(|error| retry_failure(&remote_ref, branch, &error))?;
    }
    Ok(redact_secrets(&switch_branch(repo, branch)?))
}

/// Move a local branch that isn't checked out anywhere to its classified
/// remote target, as one compare-and-swap transaction.
fn advance_local_branch(
    repo: &str,
    local_ref: &str,
    remote_ref: &str,
    update: RemoteCheckoutUpdate,
) -> Result<(), String> {
    match update {
        RemoteCheckoutUpdate::UpToDate => Ok(()),
        RemoteCheckoutUpdate::FastForward {
            local_oid,
            target_oid,
        } => move_local_ref(
            repo,
            local_ref,
            remote_ref,
            &local_oid,
            &target_oid,
            "checkout remote branch: fast-forward",
        ),
        RemoteCheckoutUpdate::AlignEquivalentSibling {
            local_oid,
            target_oid,
        } => align_equivalent_sibling(repo, local_ref, remote_ref, &local_oid, &target_oid)
            .map(|_| ()),
    }
}

fn ensure_no_operation_in_progress(repo: &str) -> Result<(), String> {
    let status = crate::git::conflicts::operation_status(repo)
        .map_err(|error| format!("Cannot inspect the repository operation state: {error}"))?;
    // The error copy names the operation with the same word the wire uses
    // (e.g. "cherry-pick"), so read it back through serde rather than
    // duplicating the rename mapping here.
    fn wire_word(value: &impl serde::Serialize) -> String {
        serde_json::to_value(value)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default()
    }
    let active = if status.kind != OperationKind::None {
        Some(wire_word(&status.kind))
    } else if status.advisory != crate::git::types::OperationAdvisory::None {
        Some(wire_word(&status.advisory))
    } else {
        None
    };
    if let Some(kind) = active {
        return Err(format!(
            "Cannot check out a remote branch while a {kind} operation is in progress. Finish or abort it first."
        ));
    }
    Ok(())
}

enum RemoteCheckoutUpdate {
    /// Equal tips, or the local branch is ahead: nothing to move.
    UpToDate,
    /// The local tip is an ancestor of the remote tip.
    FastForward {
        local_oid: String,
        target_oid: String,
    },
    AlignEquivalentSibling {
        local_oid: String,
        target_oid: String,
    },
}

impl RemoteCheckoutUpdate {
    /// The remote oid a move would verify, if this update moves anything.
    fn target_oid(&self) -> Option<&str> {
        match self {
            Self::UpToDate => None,
            Self::FastForward { target_oid, .. }
            | Self::AlignEquivalentSibling { target_oid, .. } => Some(target_oid),
        }
    }
}

/// Classify the safe updates before checkout changes HEAD. Besides ordinary
/// ancestry, two sibling commits with the same parents and tree are equivalent:
/// GitHub squash-merging a one-commit branch commonly rewrites only its commit
/// message and metadata. All other divergence remains a hard stop.
fn classify_remote_checkout(
    repo: &str,
    local_ref: &str,
    target: &str,
) -> Result<RemoteCheckoutUpdate, String> {
    let local_oid = resolve_rev(repo, local_ref)?;
    let target_oid = resolve_rev(repo, target)?;
    if local_oid == target_oid {
        return Ok(RemoteCheckoutUpdate::UpToDate);
    }
    let merge_base = run_git(repo, &["merge-base", local_ref, target])?
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    // Either ancestry direction is safe for checkout: local-behind moves
    // forward, while local-ahead stays where it is.
    if merge_base == target_oid {
        return Ok(RemoteCheckoutUpdate::UpToDate);
    }
    if merge_base == local_oid {
        return Ok(RemoteCheckoutUpdate::FastForward {
            local_oid,
            target_oid,
        });
    }

    let local_parents = commit_parents(repo, &local_oid)?;
    let target_parents = commit_parents(repo, &target_oid)?;
    let local_tree = resolve_rev(repo, &format!("{local_oid}^{{tree}}"))?;
    let target_tree = resolve_rev(repo, &format!("{target_oid}^{{tree}}"))?;
    if local_parents == target_parents && local_tree == target_tree {
        return Ok(RemoteCheckoutUpdate::AlignEquivalentSibling {
            local_oid,
            target_oid,
        });
    }

    Err(format!(
        "Cannot update {local_ref} from {target}: the local and remote branches have diverged."
    ))
}

fn commit_parents(repo: &str, oid: &str) -> Result<Vec<String>, String> {
    let out = run_git(repo, &["rev-list", "--parents", "-n", "1", oid])?;
    let mut fields = out.lines().next().unwrap_or("").split_whitespace();
    if fields.next().is_none() {
        return Err(format!("could not read parents for {oid}"));
    }
    Ok(fields.map(str::to_string).collect())
}

/// Align the local branch onto an equivalent sibling commit, without touching
/// the index or working tree (it may or may not be checked out).
pub(super) fn align_equivalent_sibling(
    repo: &str,
    local_ref: &str,
    target_ref: &str,
    local_oid: &str,
    target_oid: &str,
) -> Result<String, String> {
    move_local_ref(
        repo,
        local_ref,
        target_ref,
        local_oid,
        target_oid,
        "checkout remote branch: align equivalent commit",
    )?;
    Ok(format!("Aligned {local_ref} to {target_oid}"))
}

/// Move `local_ref` from `local_oid` to `target_oid` in one transaction that
/// also verifies `target_ref` still points at `target_oid`, so a concurrent
/// checkout or fetch cannot move it to a stale classification. The reflog
/// entry carries `reason`.
fn move_local_ref(
    repo: &str,
    local_ref: &str,
    target_ref: &str,
    local_oid: &str,
    target_oid: &str,
    reason: &str,
) -> Result<(), String> {
    let transaction = format!(
        "start\nupdate {local_ref} {target_oid} {local_oid}\nverify {target_ref} {target_oid}\ncommit\n"
    );
    run_git_with_input(repo, &["update-ref", "-m", reason, "--stdin"], &transaction)?;
    Ok(())
}
/// The retry's own git error, already redacted at the subprocess boundary,
/// kept as the cause. The stale suffix keeps it a refresh-and-retry failure.
fn retry_failure(remote_ref: &str, branch: &str, error: &str) -> WriteError {
    WriteError::stale(&format!(
        "{remote_ref} changed while {branch} was being checked out, and the retry failed: {}.",
        error.trim_end().trim_end_matches('.'),
    ))
}

#[cfg(test)]
mod tests {
    use super::{WriteError, retry_failure};

    const LOCK: &str = "fatal: cannot lock ref 'refs/heads/develop': Unable to create '/r/.git/refs/heads/develop.lock': File exists.";

    #[test]
    fn retry_failure_names_the_remote_ref_and_the_git_error() {
        let message = retry_failure("refs/remotes/origin/develop", "develop", LOCK).to_string();
        assert!(message.contains("refs/remotes/origin/develop"), "{message}");
        assert!(
            message.contains("cannot lock ref 'refs/heads/develop'"),
            "{message}"
        );
    }

    #[test]
    fn retry_failure_is_a_typed_stale_lease() {
        let error = retry_failure("refs/remotes/origin/develop", "develop", LOCK);
        assert!(matches!(error, WriteError::StaleLease(_)), "{error:?}");
    }

    #[test]
    fn retry_failure_does_not_double_the_period() {
        let message =
            retry_failure("refs/remotes/origin/develop", "develop", "File exists.\n").to_string();
        assert!(!message.contains(".."), "{message}");
        assert!(
            message.ends_with("File exists. Refresh and try again."),
            "{message}"
        );
    }

    #[test]
    fn retry_failure_keeps_a_redacted_credential_redacted() {
        // The retry's error arrives already redacted by the subprocess
        // boundary; run the same redaction here so the chain is exercised.
        let stderr =
            "fatal: unable to access 'https://user:ghp_SECRETVALUE123@example.test/repo.git/'";
        let inner = crate::redact::redact_secrets(stderr);
        let message = retry_failure("refs/remotes/origin/develop", "develop", &inner).to_string();
        assert!(
            message.contains("https://user:***@example.test"),
            "{message}"
        );
        assert!(!message.contains("SECRETVALUE123"), "{message}");
    }
}
