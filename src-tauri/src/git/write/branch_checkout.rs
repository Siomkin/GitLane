//! Branch checkout and remote-tracking checkout writes.

use crate::git::types::OperationKind;

use super::branches::{ref_exists, resolve_rev};
use super::cli::{run_git, run_git_with_input};
use super::head::{switch_branch, switch_detached};
use super::history::fast_forward_branch_at_locked;
use super::operands::ensure_operand;

/// Switch to an existing local branch or detach at an explicit revision.
/// `detached` is part of the IPC intent: one-argument `git checkout <target>` is
/// deliberately forbidden because a stale branch can be reinterpreted as a
/// pathspec and silently restore a same-named tracked file.
pub fn checkout(repo: &str, target: &str, detached: bool) -> Result<String, String> {
    let _index_guard = super::index_lock::lock_index_writes(repo)?;
    if detached {
        switch_detached(repo, target)
    } else {
        switch_branch(repo, target)
    }
}

/// Check out the local counterpart of an existing remote-tracking ref. Create
/// it with tracking when missing; when it already exists, check it out and
/// fast-forward it to the remote tip. Patch-equivalent sibling commits (same
/// parents and tree) are aligned atomically; all other divergence is refused.
/// Active merge/sequencer operations are rejected before checkout can disturb
/// their state.
pub fn checkout_remote_branch(repo: &str, remote: &str, branch: &str) -> Result<String, String> {
    let _index_guard = super::index_lock::lock_index_writes(repo)?;
    ensure_operand(remote)?;
    ensure_operand(branch)?;
    ensure_no_operation_in_progress(repo)?;
    let remote_ref = format!("refs/remotes/{remote}/{branch}");
    let local_ref = format!("refs/heads/{branch}");
    if ref_exists(repo, &local_ref) {
        // Keep the first classification as a no-switch preflight: genuine
        // divergence must not change HEAD. Reclassify after checkout because
        // either ref may move while the subprocess runs.
        classify_remote_checkout(repo, &local_ref, &remote_ref)?;
        switch_branch(repo, branch)?;
        match classify_remote_checkout(repo, &local_ref, &remote_ref).map_err(|error| {
            format!(
                "{branch} is checked out, but it couldn't be updated to {remote_ref}: {error}"
            )
        })? {
            RemoteCheckoutUpdate::FastForward => {
                let local_oid = resolve_rev(repo, &local_ref)?;
                let target_oid = resolve_rev(repo, &remote_ref)?;
                fast_forward_branch_at_locked(repo, branch, &local_oid, &target_oid).map_err(|error| {
                    format!(
                        "{branch} is checked out, but it couldn't be fast-forwarded to {remote_ref}: {error}"
                    )
                })
            }
            RemoteCheckoutUpdate::AlignEquivalentSibling {
                local_oid,
                target_oid,
            } => align_equivalent_sibling(
                repo,
                &local_ref,
                &remote_ref,
                &local_oid,
                &target_oid,
            )
            .map_err(|error| {
                    format!(
                        "{branch} is checked out, but it couldn't be aligned to {remote_ref}: {error}"
                    )
                }),
        }
    } else {
        run_git(
            repo,
            &["switch", "--track", "-c", branch, "--", &remote_ref],
        )
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

/// Move the checked-out symbolic branch without touching the index or working
/// tree. The transaction verifies both the local and remote oids under lock, so
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
