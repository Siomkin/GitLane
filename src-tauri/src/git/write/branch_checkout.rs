//! Branch checkout and remote-tracking checkout writes.

use crate::git::types::OperationKind;
use crate::redact::redact_secrets;

use super::branches::{ref_exists, resolve_rev};
use super::cli::{run_git, run_git_with_input};
use super::head::{current_branch, ensure_expected_head, switch_branch, switch_detached};
use super::history::fast_forward_branch_at_locked;
use super::operands::ensure_operand;

/// Switch to an existing local branch or detach at an explicit revision.
/// `detached` is part of the IPC intent: one-argument `git checkout <target>` is
/// deliberately forbidden because a stale branch can be reinterpreted as a
/// pathspec and silently restore a same-named tracked file.
///
/// Returns the redacted output of the quiet switch: hook output and warnings,
/// empty when there were none.
pub fn checkout(repo: &str, target: &str, detached: bool) -> Result<String, String> {
    let _index_guard = super::index_lock::lock_index_writes(repo)?;
    let output = if detached {
        switch_detached(repo, target)
    } else {
        switch_branch(repo, target)
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
pub fn checkout_remote_branch(repo: &str, remote: &str, branch: &str) -> Result<String, String> {
    let _index_guard = super::index_lock::lock_index_writes(repo)?;
    ensure_operand(remote)?;
    ensure_operand(branch)?;
    ensure_no_operation_in_progress(repo)?;
    let remote_ref = format!("refs/remotes/{remote}/{branch}");
    let local_ref = format!("refs/heads/{branch}");
    if !ref_exists(repo, &local_ref) {
        let output = run_git(
            repo,
            &[
                "switch",
                "--quiet",
                "--track",
                "-c",
                branch,
                "--",
                &remote_ref,
            ],
        )?;
        return Ok(redact_secrets(&output));
    }

    // Classify before anything moves: genuine divergence must not change HEAD
    // or the local ref.
    let update = classify_remote_checkout(repo, &local_ref, &remote_ref)?;

    if current_branch(repo).as_deref() == Some(branch) {
        let output = update_local_branch(repo, branch, &local_ref, &remote_ref, update).map_err(
            |error| {
                format!(
                    "{branch} is checked out, but it couldn't be updated to {remote_ref}: {error}"
                )
            },
        )?;
        return Ok(redact_secrets(&output));
    }

    // Git refuses to switch to a branch another worktree holds. Refuse first,
    // so the ref isn't advanced inside that worktree for a switch that fails.
    if let Some(holder) = super::worktrees::worktrees(repo)?
        .into_iter()
        .find(|wt| wt.branch.as_deref() == Some(branch) && !wt.bare && !wt.prunable)
    {
        return Err(format!(
            "{branch} is checked out in another worktree ({}). Open that worktree to update it.",
            holder.path
        ));
    }

    // Not checked out anywhere: moving the ref is a compare-and-swap with no
    // working-tree side effects. If the switch below is then refused (dirty
    // files), HEAD stays put and the branch is simply already up to date.
    update_local_branch(repo, branch, &local_ref, &remote_ref, update)?;
    Ok(redact_secrets(&switch_branch(repo, branch)?))
}

/// Apply a classified remote update to the local branch. For the checked-out
/// branch this is `merge --ff-only` (or an index-preserving ref alignment); for
/// any other branch it only moves the ref.
fn update_local_branch(
    repo: &str,
    branch: &str,
    local_ref: &str,
    remote_ref: &str,
    update: RemoteCheckoutUpdate,
) -> Result<String, String> {
    match update {
        RemoteCheckoutUpdate::FastForward => {
            let local_oid = resolve_rev(repo, local_ref)?;
            let target_oid = resolve_rev(repo, remote_ref)?;
            if local_oid == target_oid {
                return Ok(String::new());
            }
            // Local ahead of the remote: nothing to move.
            if run_git(
                repo,
                &["merge-base", "--is-ancestor", &local_oid, &target_oid],
            )
            .is_err()
            {
                return Ok(String::new());
            }
            if current_branch(repo).as_deref() == Some(branch) {
                // Same guard as `fast_forward_branch_at_locked`, but quiet: the
                // output that survives is `post-merge` hook output, not git's
                // "Updating…/Fast-forward" diffstat.
                ensure_expected_head(repo, Some(branch), Some(&local_oid))?;
                return run_git(repo, &["merge", "--ff-only", "--quiet", &target_oid]);
            }
            fast_forward_branch_at_locked(repo, branch, &local_oid, &target_oid)
        }
        RemoteCheckoutUpdate::AlignEquivalentSibling {
            local_oid,
            target_oid,
        } => align_equivalent_sibling(repo, local_ref, remote_ref, &local_oid, &target_oid)
            .map(|_| String::new()),
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
    FastForward,
    AlignEquivalentSibling {
        local_oid: String,
        target_oid: String,
    },
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
        return Ok(RemoteCheckoutUpdate::FastForward);
    }
    let merge_base = run_git(repo, &["merge-base", local_ref, target])?
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    // Either ancestry direction is safe for checkout: local-behind moves
    // forward, while local-ahead makes `merge --ff-only` an up-to-date no-op.
    if merge_base == local_oid || merge_base == target_oid {
        return Ok(RemoteCheckoutUpdate::FastForward);
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

/// Move the local branch ref without touching the index or working tree (it
/// may or may not be checked out). The transaction verifies both the local and remote oids under lock, so
/// a concurrent checkout or fetch cannot align to a stale classification.
pub(super) fn align_equivalent_sibling(
    repo: &str,
    local_ref: &str,
    target_ref: &str,
    local_oid: &str,
    target_oid: &str,
) -> Result<String, String> {
    let transaction = format!(
        "start\nupdate {local_ref} {target_oid} {local_oid}\nverify {target_ref} {target_oid}\ncommit\n"
    );
    run_git_with_input(
        repo,
        &[
            "update-ref",
            "-m",
            "checkout remote branch: align equivalent commit",
            "--stdin",
        ],
        &transaction,
    )?;
    Ok(format!("Aligned {local_ref} to {target_oid}"))
}
