//! Moving a branch from one worktree to another: detach the source, carry its
//! work across as a stash, and roll every step back when a later one fails.

use crate::git::handoff;

use super::super::cli::run_git;
use super::super::operands::ensure_operand;
use super::dirty::{has_unmerged, is_dirty, status_entry_count};
use super::lifecycle::{ensure_worktree_has_branch, ensure_worktree_registered};
use super::paths::worktree_git_dir;
use super::stash::{drop_all, push_stash, restore_stash};

/// Hand `branch` off from one worktree to another, optionally carrying the
/// source worktree's uncommitted changes (GL-74).
///
/// Git only allows a local branch to be checked out in one worktree at a time, so
/// the branch is freed by detaching the source worktree at its current HEAD, then
/// checked out in the destination. Unlike the old "both worktrees must be clean"
/// rule, this variant works mid-edit:
///
/// - The **source's** uncommitted changes ride along in a stash (when `carry`)
///   and re-apply cleanly in the destination (same base commit).
/// - The **destination's** own uncommitted changes are stashed before the switch
///   and re-applied after, so a dirty destination is allowed. Re-applying them
///   crosses the branch boundary and can conflict; that routes into the conflict
///   workspace via a `"carry"` operation (see [`crate::git::handoff`]).
///
/// Stashes are recorded by oid and never dropped until applied, so every failure
/// path leaves the work recoverable.
///
/// `progress` is invoked as each phase *begins* (step ids: `stashSource`,
/// `stashDestination`, `detach`, `checkout`, `applySource`, `applyDestination`,
/// `finalize`) so the UI can show a live checklist. The command layer forwards
/// them as `handoff-progress` Tauri events; steps that don't apply (a clean
/// source/destination) simply never fire.
pub fn move_branch_to_worktree(
    repo: &str,
    branch: &str,
    from_worktree_path: &str,
    to_worktree_path: &str,
    carry: bool,
    progress: &dyn Fn(&'static str),
) -> Result<String, String> {
    // Handoff mutates both worktrees' indexes (stash/checkout/apply). One
    // commondir-keyed lock covers the whole sequence.
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    let _stash_guard = super::super::stashes::lock_stash_writes()?;
    ensure_operand(branch)?;
    ensure_operand(from_worktree_path)?;
    ensure_operand(to_worktree_path)?;
    ensure_worktree_has_branch(repo, from_worktree_path, branch)?;
    ensure_worktree_registered(repo, to_worktree_path, from_worktree_path)?;

    let from = from_worktree_path;
    let to = to_worktree_path;
    let dest_label = to.trim_end_matches('/').rsplit('/').next().unwrap_or(to);

    // Refuse a worktree mid-conflict up front: `git stash push` fails on unmerged
    // index entries with an opaque error, and moving a branch into/out of an
    // unresolved merge would strand that operation. Fail with a clear message.
    if has_unmerged(from) {
        return Err(
            "The source worktree has unresolved conflicts. Resolve them first.".to_string(),
        );
    }
    if has_unmerged(to) {
        return Err(
            "The destination worktree has unresolved conflicts. Resolve them first.".to_string(),
        );
    }

    let source_changes = status_entry_count(from)?;
    let source_dirty = source_changes > 0;
    if source_dirty && !carry {
        return Err(
            "The source worktree has uncommitted changes. Carry them along, or commit/stash them first."
                .to_string(),
        );
    }

    // 1. Stash the source's changes (they ride along with the branch).
    let source_stash = if source_dirty {
        progress("stashSource");
        Some(push_stash(from, &format!("GitLane: handoff {branch}"))?)
    } else {
        None
    };

    // 2. Stash the destination's own uncommitted work so the branch can be
    //    checked out into a clean tree; it is re-applied in step 6. If this fails
    //    after the source was stashed, restore the source first — otherwise its
    //    edits are stranded in a stash while the branch hasn't moved (GL-74 P2).
    let dest_dirty = match is_dirty(to) {
        Ok(dirty) => dirty,
        Err(e) => {
            if let Some(o) = &source_stash {
                restore_stash(from, o);
            }
            return Err(e);
        }
    };
    let dest_stash = if dest_dirty {
        progress("stashDestination");
        match push_stash(to, "GitLane: destination changes") {
            Ok(oid) => Some(oid),
            Err(e) => {
                if let Some(o) = &source_stash {
                    restore_stash(from, o);
                }
                return Err(e);
            }
        }
    } else {
        None
    };

    // 3. Free the branch by detaching the source at its current HEAD.
    progress("detach");
    if let Err(e) = super::super::head::switch_detached(from, "HEAD") {
        // Source is still on `branch`; just restore both stashes.
        if let Some(o) = &dest_stash {
            restore_stash(to, o);
        }
        if let Some(o) = &source_stash {
            restore_stash(from, o);
        }
        return Err(format!("Couldn't detach the source worktree: {e}"));
    }

    // 4. Check the branch out in the (now clean) destination.
    progress("checkout");
    if let Err(e) = super::super::head::switch_branch(to, branch) {
        // Roll back: re-attach the source to its branch, restore both stashes.
        let _ = super::super::head::switch_branch(from, branch);
        if let Some(o) = &source_stash {
            restore_stash(from, o);
        }
        if let Some(o) = &dest_stash {
            restore_stash(to, o);
        }
        return Err(format!(
            "Couldn't check out {branch} in the destination: {e}"
        ));
    }

    // From here the structural move has landed (branch is in the destination); we
    // always return Ok and describe how the carry fared. Cleanly-applied stashes
    // are held (applied, not dropped) until the whole carry succeeds, so a later
    // conflict's `abort` (reset --hard) can't lose the already-applied work — it
    // is still recoverable from the stack. On success we drop them all.
    let mut applied: Vec<String> = Vec::new();

    // 5. Re-apply the carried source changes onto the destination. The stash was
    //    taken at this branch's tip and the destination now sits at that tip, so
    //    this applies cleanly in practice.
    if let Some(o) = &source_stash {
        progress("applySource");
        match run_git(to, &["stash", "apply", o]) {
            Ok(_) => applied.push(o.clone()),
            Err(_) if has_unmerged(to) => {
                progress("finalize");
                return carry_conflict(
                    to,
                    branch,
                    dest_label,
                    &applied,
                    o,
                    "resolve the carried changes",
                );
            }
            Err(_) => {
                progress("finalize");
                drop_all(to, &applied);
                return Ok(format!(
                    "Handed off {branch} to {dest_label}; the carried changes couldn't apply and are kept in a stash"
                ));
            }
        }
    }

    // 6. Re-apply the destination's own prior changes over the handed-off branch.
    //    This crosses the branch boundary, so it can genuinely conflict.
    if let Some(o) = &dest_stash {
        progress("applyDestination");
        match run_git(to, &["stash", "apply", o]) {
            Ok(_) => applied.push(o.clone()),
            Err(_) if has_unmerged(to) => {
                progress("finalize");
                return carry_conflict(
                    to,
                    branch,
                    dest_label,
                    &applied,
                    o,
                    "resolve the destination's conflicting changes",
                );
            }
            Err(_) => {
                progress("finalize");
                drop_all(to, &applied);
                return Ok(format!(
                    "Handed off {branch} to {dest_label}; the destination's prior changes overlap the carried work and are kept in a stash"
                ));
            }
        }
    }

    progress("finalize");
    drop_all(to, &applied);
    Ok(if source_dirty {
        format!(
            "Handed off {branch} to {dest_label} with {source_changes} carried change{}",
            if source_changes == 1 { "" } else { "s" }
        )
    } else {
        format!("Moved {branch} to {dest_label}")
    })
}

/// A carry step left unmerged entries: record every still-needed stash (the ones
/// applied cleanly so far plus the conflicting one) in the handoff marker so the
/// conflict workspace opens, `continue` can drop them once resolved, and `abort`
/// (reset --hard) preserves them. Nothing is dropped here.
fn carry_conflict(
    worktree: &str,
    branch: &str,
    dest_label: &str,
    applied: &[String],
    conflicting: &str,
    verb: &str,
) -> Result<String, String> {
    let mut kept: Vec<&str> = applied.iter().map(String::as_str).collect();
    kept.push(conflicting);
    handoff::write_marker(&worktree_git_dir(worktree)?, &kept.join("\n"))?;
    Ok(format!("Handed off {branch} to {dest_label} — {verb}"))
}
