//! Stashing a worktree's work aside during a handoff, and putting it back.
//! Stashes are global (`refs/stash` in the common dir), so every push here is
//! tagged with a unique message and tracked by its commit oid rather than by a
//! `stash@{n}` index that a concurrent push would shift.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use super::super::cli::run_git;

static STASH_ATTEMPT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Push a stash (including untracked files) in `worktree` and return the created
/// stash commit's oid. Stashes are global (`refs/stash` in the common dir), so we
/// always apply/drop **by oid** rather than by `stash@{n}` — a sibling worktree's
/// stash can otherwise sit at index 0 and be popped into the wrong tree.
pub(super) fn push_stash(worktree: &str, message: &str) -> Result<String, String> {
    // A stash commit's oid includes its message, but Git timestamps commits only
    // to the second. Re-applying an existing stash and immediately pushing the
    // same changes with the same message can therefore reproduce the exact oid.
    // Git still cleans the worktree in that case, yet refs/stash does not move.
    // Give every handoff attempt a unique commit message so a successful push
    // always creates a distinct, independently droppable stash entry — which is
    // exactly what `StashPush::oid` reports (it is `None` when the ref stood
    // still), so the handoff never adopts a sibling worktree's existing stash.
    let message = unique_stash_message(message);
    super::super::stash_push::push_stash(
        worktree,
        &["stash", "push", "--include-untracked", "-m", &message],
    )?
    .oid
    .ok_or_else(|| {
        "Git did not create a stash for these changes. Dirty submodules cannot be carried; commit or stash them inside the submodule first."
            .to_string()
    })
}

pub(super) fn unique_stash_message(message: &str) -> String {
    let sequence = STASH_ATTEMPT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{message} [GitLane attempt {}-{timestamp}-{sequence}]",
        std::process::id()
    )
}

/// Drop the stash whose commit oid is `oid`, wherever it sits in the (global)
/// stash list. A no-op when it's already gone (idempotent), so rollback paths
/// stay safe. Shared with `conflict_resolution` (carry-continue drops the kept
/// stashes by oid).
pub(in crate::git::write) fn drop_stash_by_oid(worktree: &str, oid: &str) -> Result<(), String> {
    let list = run_git(worktree, &["stash", "list", "--format=%H"])?;
    if let Some(index) = list.lines().position(|line| line.trim() == oid) {
        run_git(worktree, &["stash", "drop", &format!("stash@{{{index}}}")])?;
    }
    Ok(())
}

/// Best-effort restore of a stash back into a worktree on a rollback path: apply
/// it, then drop it. Failures are swallowed — the stash stays on the stack for
/// manual recovery, so nothing is ever lost.
pub(super) fn restore_stash(worktree: &str, oid: &str) {
    if run_git(worktree, &["stash", "apply", oid]).is_ok() {
        let _ = drop_stash_by_oid(worktree, oid);
    }
}

/// Drop each stash by oid (best-effort ordering-safe cleanup after a clean carry).
pub(super) fn drop_all(worktree: &str, oids: &[String]) {
    for oid in oids {
        let _ = drop_stash_by_oid(worktree, oid);
    }
}
