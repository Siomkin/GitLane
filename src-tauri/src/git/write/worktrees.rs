//! Linked-worktree operations backed by git porcelain.

use std::path::PathBuf;

use crate::git::handoff;
use crate::git::types::WorktreeInfo;

use super::cli::run_git;
use super::operands::{ensure_operand, ensure_opt};

/// List linked worktrees via `git worktree list --porcelain`. This is a read,
/// but uses the CLI's stable porcelain output rather than libgit2's awkward
/// worktree API. The first entry is always the primary (main) worktree.
pub fn worktrees(repo: &str) -> Result<Vec<WorktreeInfo>, String> {
    let raw = run_git(repo, &["worktree", "list", "--porcelain"])?;
    let mut out = Vec::new();
    let mut path: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut first = true;

    let mut flush = |path: &mut Option<String>, branch: &mut Option<String>, first: &mut bool| {
        if let Some(p) = path.take() {
            let name = p.rsplit('/').next().unwrap_or(&p).to_string();
            out.push(WorktreeInfo {
                name,
                path: p,
                branch: branch.take(),
                is_main: std::mem::replace(first, false),
            });
        } else {
            *branch = None;
        }
    };

    for line in raw.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            flush(&mut path, &mut branch, &mut first);
            path = Some(p.trim().to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            branch = Some(b.trim().trim_start_matches("refs/heads/").to_string());
        }
    }
    flush(&mut path, &mut branch, &mut first);
    Ok(out)
}

/// Create a new linked worktree at `worktree_path`, checked out to `reference`
/// (a branch, tag, or commit; defaults to HEAD). When `reference` is a commit or
/// a tag the new worktree is detached; an existing branch is checked out there
/// (git refuses if it's already checked out elsewhere, surfacing its own error).
pub fn add_worktree(
    repo: &str,
    worktree_path: &str,
    reference: Option<&str>,
) -> Result<String, String> {
    ensure_operand(worktree_path)?;
    ensure_opt(reference)?;
    match reference {
        Some(r) => run_git(repo, &["worktree", "add", worktree_path, r]),
        None => run_git(repo, &["worktree", "add", worktree_path]),
    }
}

/// Remove a linked worktree (`git worktree remove <path>`). `force` adds
/// `--force`, dropping git's dirty/locked safety check. Git refuses to remove the
/// main worktree, surfacing its own error; the frontend also hides the action there.
pub fn remove_worktree(repo: &str, worktree_path: &str, force: bool) -> Result<String, String> {
    ensure_operand(worktree_path)?;
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(worktree_path);
    run_git(repo, &args)?;
    Ok(format!("Removed worktree {worktree_path}"))
}

/// Compare two worktree paths on their resolved real path: git's porcelain
/// output canonicalizes (e.g. macOS `/var` → `/private/var`), so a raw string
/// compare against a UI-supplied path can spuriously miss. Falls back to a
/// trimmed compare when a path can't be resolved (e.g. it's already gone).
fn same_path(a: &str, b: &str) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a.trim_end_matches('/') == b.trim_end_matches('/'),
    }
}

/// Re-read the worktree list and confirm `from_worktree_path` is still registered
/// and still has `branch` checked out. The frontend captures the path when its
/// menu opens; an external `git worktree`/checkout in between could move the
/// branch elsewhere (or detach that worktree), so verify against live state and
/// fail closed *before* removing/detaching anything — otherwise we could destroy
/// a clean, unrelated worktree and delete the branch regardless.
fn ensure_worktree_has_branch(repo: &str, from_worktree_path: &str, branch: &str) -> Result<(), String> {
    match worktrees(repo)?
        .into_iter()
        .find(|w| same_path(&w.path, from_worktree_path))
    {
        Some(w) if w.branch.as_deref() == Some(branch) => Ok(()),
        Some(_) => Err(format!(
            "{branch} is no longer checked out at {from_worktree_path}. Refresh and try again."
        )),
        None => Err(format!(
            "No worktree is registered at {from_worktree_path} anymore. Refresh and try again."
        )),
    }
}

/// The destination must be a real, registered worktree of this repo and distinct
/// from the source — verified against live state before we detach anything.
fn ensure_worktree_registered(repo: &str, to: &str, from: &str) -> Result<(), String> {
    if same_path(to, from) {
        return Err("The destination is the same worktree as the source.".into());
    }
    if worktrees(repo)?.iter().any(|w| same_path(&w.path, to)) {
        Ok(())
    } else {
        Err(format!(
            "No worktree is registered at {to}. Refresh and try again."
        ))
    }
}

fn is_dirty(worktree: &str) -> Result<bool, String> {
    Ok(!run_git(worktree, &["status", "--porcelain"])?.trim().is_empty())
}

/// True when the worktree has unmerged (conflicted) index entries.
fn has_unmerged(worktree: &str) -> bool {
    run_git(worktree, &["ls-files", "-u"])
        .map(|out| !out.trim().is_empty())
        .unwrap_or(false)
}

/// The absolute git dir of a (possibly linked) worktree — where the handoff
/// marker lives. Matches libgit2's `Repository::path` on the read side. Shared
/// with `conflict_resolution` so continue/abort resolve the same marker.
pub(super) fn worktree_git_dir(worktree: &str) -> Result<PathBuf, String> {
    Ok(PathBuf::from(
        run_git(worktree, &["rev-parse", "--absolute-git-dir"])?.trim(),
    ))
}

/// Push a stash (including untracked files) in `worktree` and return the created
/// stash commit's oid. Stashes are global (`refs/stash` in the common dir), so we
/// always apply/drop **by oid** rather than by `stash@{n}` — a sibling worktree's
/// stash can otherwise sit at index 0 and be popped into the wrong tree.
fn push_stash(worktree: &str, message: &str) -> Result<String, String> {
    run_git(
        worktree,
        &["stash", "push", "--include-untracked", "-m", message],
    )?;
    Ok(run_git(worktree, &["rev-parse", "refs/stash"])?.trim().to_string())
}

/// Drop the stash whose commit oid is `oid`, wherever it sits in the (global)
/// stash list. A no-op when it's already gone (idempotent), so rollback paths
/// stay safe. Shared with `conflict_resolution` (carry-continue drops the kept
/// stashes by oid).
pub(super) fn drop_stash_by_oid(worktree: &str, oid: &str) -> Result<(), String> {
    let list = run_git(worktree, &["stash", "list", "--format=%H"])?;
    if let Some(index) = list.lines().position(|line| line.trim() == oid) {
        run_git(worktree, &["stash", "drop", &format!("stash@{{{index}}}")])?;
    }
    Ok(())
}

/// Best-effort restore of a stash back into a worktree on a rollback path: apply
/// it, then drop it. Failures are swallowed — the stash stays on the stack for
/// manual recovery, so nothing is ever lost.
fn restore_stash(worktree: &str, oid: &str) {
    if run_git(worktree, &["stash", "apply", oid]).is_ok() {
        let _ = drop_stash_by_oid(worktree, oid);
    }
}

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
pub fn move_branch_to_worktree(
    repo: &str,
    branch: &str,
    from_worktree_path: &str,
    to_worktree_path: &str,
    carry: bool,
) -> Result<String, String> {
    ensure_operand(branch)?;
    ensure_operand(from_worktree_path)?;
    ensure_operand(to_worktree_path)?;
    ensure_worktree_has_branch(repo, from_worktree_path, branch)?;
    ensure_worktree_registered(repo, to_worktree_path, from_worktree_path)?;

    let from = from_worktree_path;
    let to = to_worktree_path;
    let dest_label = to.trim_end_matches('/').rsplit('/').next().unwrap_or(to);

    let source_status = run_git(from, &["status", "--porcelain"])?;
    let source_changes = source_status.lines().filter(|l| !l.trim().is_empty()).count();
    let source_dirty = source_changes > 0;
    if source_dirty && !carry {
        return Err(format!(
            "The source worktree has uncommitted changes. Carry them along, or commit/stash them first."
        ));
    }

    // 1. Stash the source's changes (they ride along with the branch).
    let source_stash = if source_dirty {
        Some(push_stash(from, &format!("GitLane: handoff {branch}"))?)
    } else {
        None
    };

    // 2. Stash the destination's own uncommitted work so the branch can be
    //    checked out into a clean tree; it is re-applied in step 6.
    let dest_stash = if is_dirty(to)? {
        Some(push_stash(to, "GitLane: destination changes")?)
    } else {
        None
    };

    // 3. Free the branch by detaching the source at its current HEAD.
    if let Err(e) = run_git(from, &["checkout", "--detach"]) {
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
    if let Err(e) = run_git(to, &["checkout", branch]) {
        // Roll back: re-attach the source to its branch, restore both stashes.
        let _ = run_git(from, &["checkout", branch]);
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
        match run_git(to, &["stash", "apply", o]) {
            Ok(_) => applied.push(o.clone()),
            Err(_) if has_unmerged(to) => {
                return carry_conflict(to, branch, dest_label, &applied, o, "resolve the carried changes");
            }
            Err(_) => {
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
        match run_git(to, &["stash", "apply", o]) {
            Ok(_) => applied.push(o.clone()),
            Err(_) if has_unmerged(to) => {
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
                drop_all(to, &applied);
                return Ok(format!(
                    "Handed off {branch} to {dest_label}; the destination's prior changes overlap the carried work and are kept in a stash"
                ));
            }
        }
    }

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

/// Drop each stash by oid (best-effort ordering-safe cleanup after a clean carry).
fn drop_all(worktree: &str, oids: &[String]) {
    for oid in oids {
        let _ = drop_stash_by_oid(worktree, oid);
    }
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

/// Remove the linked worktree at `from_worktree_path`, then delete `branch`.
///
/// Git refuses to delete a branch that is checked out in a worktree, so this is
/// the one-step path for "I'm done with this branch and its worktree": free the
/// branch by removing its worktree, then force-delete the branch. The worktree
/// removal runs first and is *not* forced, so a dirty or locked worktree aborts
/// the whole operation (git's error surfaces) before the branch is touched.
pub fn delete_branch_with_worktree(
    repo: &str,
    branch: &str,
    from_worktree_path: &str,
) -> Result<String, String> {
    ensure_operand(branch)?;
    ensure_operand(from_worktree_path)?;
    ensure_worktree_has_branch(repo, from_worktree_path, branch)?;
    remove_worktree(repo, from_worktree_path, false)?;
    super::branches::delete_branch(repo, branch, true)?;
    Ok(format!("Deleted {branch} and its worktree"))
}
