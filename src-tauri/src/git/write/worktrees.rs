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
    // Per-entry attribute flags, reset at each `worktree` boundary. `bare`
    // (main is a bare repo) and `prunable` (directory gone) both mean the entry
    // has no usable working tree — a branch can't be checked out into it.
    // `locked` means git refuses removal without `--force --force`.
    let mut bare = false;
    let mut prunable = false;
    let mut locked = false;
    let mut first = true;

    let mut flush = |path: &mut Option<String>,
                     branch: &mut Option<String>,
                     bare: &mut bool,
                     prunable: &mut bool,
                     locked: &mut bool,
                     first: &mut bool| {
        if let Some(p) = path.take() {
            let name = p.rsplit('/').next().unwrap_or(&p).to_string();
            out.push(WorktreeInfo {
                name,
                path: p,
                branch: branch.take(),
                is_main: std::mem::replace(first, false),
                bare: std::mem::replace(bare, false),
                prunable: std::mem::replace(prunable, false),
                locked: std::mem::replace(locked, false),
            });
        } else {
            *branch = None;
            *bare = false;
            *prunable = false;
            *locked = false;
        }
    };

    for line in raw.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            flush(&mut path, &mut branch, &mut bare, &mut prunable, &mut locked, &mut first);
            path = Some(p.trim().to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            branch = Some(b.trim().trim_start_matches("refs/heads/").to_string());
        } else if line == "bare" {
            bare = true;
        } else if line == "prunable" || line.starts_with("prunable ") {
            prunable = true;
        } else if line == "locked" || line.starts_with("locked ") {
            locked = true;
        }
    }
    flush(&mut path, &mut branch, &mut bare, &mut prunable, &mut locked, &mut first);
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
/// `--force`, dropping git's dirty-worktree safety check. A *locked* worktree
/// needs a **second** `--force` (git refuses `-f` alone: "cannot remove a locked
/// working tree; use 'remove -f -f'"), so when the caller forces the removal and
/// the target is locked we pass `-f -f`. Git refuses to remove the main worktree,
/// surfacing its own error; the frontend also hides the action there.
pub fn remove_worktree(repo: &str, worktree_path: &str, force: bool) -> Result<String, String> {
    ensure_operand(worktree_path)?;
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
        // Only the caller-forced path may override a lock — an unforced remove
        // still surfaces git's "locked working tree" error so the UI can prompt.
        if worktree_is_locked(repo, worktree_path) {
            args.push("--force");
        }
    }
    args.push(worktree_path);
    run_git(repo, &args)?;
    Ok(format!("Removed worktree {worktree_path}"))
}

/// Whether the worktree at `path` is locked, from live `git worktree list` state.
/// A read failure returns false (we then let git's own error surface).
fn worktree_is_locked(repo: &str, path: &str) -> bool {
    worktrees(repo)
        .ok()
        .into_iter()
        .flatten()
        .any(|w| same_path(&w.path, path) && w.locked)
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

/// The destination must be a real, registered worktree of this repo, distinct
/// from the source, and one a branch can actually be checked out into — verified
/// against live state before we detach anything. A bare repo (no working tree) or
/// a prunable worktree (directory gone) would fail the checkout after we'd already
/// detached the source, so reject them up front with a clear message.
fn ensure_worktree_registered(repo: &str, to: &str, from: &str) -> Result<(), String> {
    if same_path(to, from) {
        return Err("The destination is the same worktree as the source.".into());
    }
    match worktrees(repo)?.into_iter().find(|w| same_path(&w.path, to)) {
        Some(w) if w.bare => Err(
            "The destination is a bare repository — it has no working tree to check the branch out into.".into(),
        ),
        Some(w) if w.prunable => {
            Err("The destination worktree's directory is missing. Refresh and try again.".into())
        }
        Some(_) => Ok(()),
        None => Err(format!(
            "No worktree is registered at {to}. Refresh and try again."
        )),
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
        return Err("The source worktree has unresolved conflicts. Resolve them first.".to_string());
    }
    if has_unmerged(to) {
        return Err(
            "The destination worktree has unresolved conflicts. Resolve them first.".to_string(),
        );
    }

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
    progress("checkout");
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
        progress("applySource");
        match run_git(to, &["stash", "apply", o]) {
            Ok(_) => applied.push(o.clone()),
            Err(_) if has_unmerged(to) => {
                progress("finalize");
                return carry_conflict(to, branch, dest_label, &applied, o, "resolve the carried changes");
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
