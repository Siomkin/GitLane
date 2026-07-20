//! Linked-worktree operations backed by git porcelain.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::git::handoff;
use crate::git::types::{WorktreeDirtyState, WorktreeInfo};

use super::cli::{run_git, run_git_allow_exit_codes, run_git_stdout, run_git_stdout_raw};
use super::operands::{ensure_operand, ensure_opt};

static STASH_ATTEMPT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// List linked worktrees via `git worktree list --porcelain`. This is a read,
/// but uses the CLI's stable porcelain output rather than libgit2's awkward
/// worktree API. The first entry is always the primary (main) worktree.
pub fn worktrees(repo: &str) -> Result<Vec<WorktreeInfo>, String> {
    let raw = run_git_stdout_raw(repo, &["worktree", "list", "--porcelain", "-z"])?;
    let mut out = Vec::new();
    let mut path: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut head: Option<String> = None;
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
                     head: &mut Option<String>,
                     bare: &mut bool,
                     prunable: &mut bool,
                     locked: &mut bool,
                     first: &mut bool| {
        if let Some(p) = path.take() {
            let name = std::path::Path::new(&p)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(&p)
                .to_string();
            out.push(WorktreeInfo {
                name,
                path: p,
                branch: branch.take(),
                head: head.take(),
                is_main: std::mem::replace(first, false),
                bare: std::mem::replace(bare, false),
                prunable: std::mem::replace(prunable, false),
                locked: std::mem::replace(locked, false),
            });
        } else {
            *branch = None;
            *head = None;
            *bare = false;
            *prunable = false;
            *locked = false;
        }
    };

    for field in raw
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
    {
        let line = String::from_utf8_lossy(field);
        if let Some(p) = line.strip_prefix("worktree ") {
            flush(
                &mut path,
                &mut branch,
                &mut head,
                &mut bare,
                &mut prunable,
                &mut locked,
                &mut first,
            );
            path = Some(p.to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            branch = Some(b.trim_start_matches("refs/heads/").to_string());
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            head = Some(h.to_string());
        } else if line.as_ref() == "bare" {
            bare = true;
        } else if line.as_ref() == "prunable" || line.starts_with("prunable ") {
            prunable = true;
        } else if line.as_ref() == "locked" || line.starts_with("locked ") {
            locked = true;
        }
    }
    flush(
        &mut path,
        &mut branch,
        &mut head,
        &mut bare,
        &mut prunable,
        &mut locked,
        &mut first,
    );
    Ok(out)
}

/// Create a new linked worktree at `worktree_path`.
///
/// With `new_branch` set, a fresh branch of that name is created at `reference`
/// (its start point, defaulting to HEAD) and checked out there in one step
/// (`git worktree add -b <new> <path> <start>`) — git refuses if the branch
/// already exists, surfacing its own error.
///
/// Without `new_branch`, the worktree is checked out to `reference` directly (a
/// branch, tag, or commit; defaults to HEAD): a commit or tag detaches, an
/// existing branch is checked out (git refuses if it's already checked out
/// elsewhere, surfacing its own error).
pub fn add_worktree(
    repo: &str,
    worktree_path: &str,
    reference: Option<&str>,
    new_branch: Option<&str>,
) -> Result<String, String> {
    ensure_operand(worktree_path)?;
    ensure_opt(reference)?;
    ensure_opt(new_branch)?;
    match (new_branch, reference) {
        // `-b <new> <path> <start>` — create the branch at its start point.
        (Some(branch), Some(start)) => run_git(
            repo,
            &["worktree", "add", "-b", branch, worktree_path, start],
        ),
        (Some(branch), None) => run_git(repo, &["worktree", "add", "-b", branch, worktree_path]),
        (None, Some(r)) => run_git(repo, &["worktree", "add", worktree_path, r]),
        (None, None) => run_git(repo, &["worktree", "add", worktree_path]),
    }
}

/// Create and check out a branch in an existing detached worktree.
///
/// The menu captures the worktree's path and HEAD oid. Re-read the registered
/// worktree state and validate its detached HEAD before mutating so an external
/// checkout cannot redirect this action to a different commit or branch.
/// `git switch -c` performs the ref creation and checkout as one logical git
/// operation, avoiding a branch-created-but-not-checked-out partial result.
pub fn create_branch_in_worktree(
    repo: &str,
    worktree_path: &str,
    name: &str,
    expected_oid: &str,
) -> Result<String, String> {
    ensure_operand(worktree_path)?;
    ensure_operand(name)?;
    ensure_operand(expected_oid)?;

    let worktree = worktrees(repo)?
        .into_iter()
        .find(|worktree| same_path(&worktree.path, worktree_path))
        .ok_or_else(|| {
            format!("No worktree is registered at {worktree_path} anymore. Refresh and try again.")
        })?;
    if worktree.bare {
        return Err("A bare repository has no working tree to attach a branch to.".into());
    }
    if worktree.prunable {
        return Err("The worktree's directory is missing. Refresh and try again.".into());
    }
    if let Some(branch) = worktree.branch {
        return Err(format!(
            "The worktree is no longer detached; it has {branch} checked out. Refresh and try again."
        ));
    }
    if worktree.head.as_deref() != Some(expected_oid) {
        return Err("The worktree's HEAD changed. Refresh and try again.".into());
    }

    super::head::ensure_expected_head(worktree_path, None, Some(expected_oid))?;
    run_git(worktree_path, &["switch", "-c", name])?;
    Ok(format!("Created {name} in worktree {}", worktree.name))
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

/// Count the uncommitted work in a linked worktree, so a removal confirm can
/// say what a forced remove would destroy instead of leaving the user to
/// discover it from git's `fatal: ... contains modified or untracked files`.
///
/// Runs `git status` *inside the worktree* — a linked worktree is a valid git
/// directory, so it is its own `repo` operand here. `--untracked-files=all`
/// expands untracked directories to real files: the default collapses them to
/// one entry per directory, which would understate the loss in the warning.
///
/// Ignored entries are counted separately and *collapsed* by directory — see the
/// second call below. They do not make a worktree dirty (git deletes them on an
/// unforced remove) but they are reported so a removal can say that a local
/// `.env` or a build directory is about to go with it.
///
/// This is a read, but it lives beside the removal it guards rather than in
/// `read.rs`, and it is called on demand (never from the worktree list refresh).
pub fn worktree_dirty_state(worktree_path: &str) -> Result<WorktreeDirtyState, String> {
    ensure_operand(worktree_path)?;
    // stdout only, untrimmed — see `run_git_stdout`: the combined/trimmed form
    // would both invent records from stderr warnings and strip the leading
    // status column off the first one.
    let raw = run_git_stdout(
        worktree_path,
        &["status", "--porcelain", "--untracked-files=all"],
    )?;
    let mut modified = 0u32;
    let mut untracked = 0u32;
    for line in raw.lines().filter(|line| is_porcelain_record(line)) {
        if line.starts_with("??") {
            untracked += 1;
        } else {
            modified += 1;
        }
    }
    // Ignored entries need a *second* call. `--ignored` cannot ride along with
    // the `--untracked-files=all` above: that combination expands ignored
    // directories file by file, so a single `node_modules` turns a millisecond
    // probe into an enormous listing. On its own, `--ignored` collapses them to
    // one record per directory — both cheaper and the more readable count.
    //
    // A failure here degrades to zero rather than failing the probe: not knowing
    // the ignored count costs a sentence in a warning, whereas failing the whole
    // probe would withhold the worktree from the sweep entirely.
    let ignored = run_git_stdout(worktree_path, &["status", "--porcelain", "--ignored"])
        .map(|raw| {
            raw.lines()
                .filter(|line| is_porcelain_record(line) && line.starts_with("!!"))
                .count() as u32
        })
        .unwrap_or(0);

    Ok(WorktreeDirtyState {
        modified,
        untracked,
        ignored,
    })
}

/// Whether a line is a porcelain v1 status record (`XY <path>`) rather than
/// something git wrote to stderr.
///
/// `run_git` returns stdout and stderr *combined* on success, so a plain
/// `lines()` count would score a warning ("warning: unable to access ...") as a
/// changed file — inflating the confirm's numbers and, on an otherwise clean
/// worktree, forcing a removal that never needed forcing. Matching the record
/// shape keeps that to the probe rather than changing `run_git`, whose combined
/// output other callers rely on.
pub(super) fn is_porcelain_record(line: &str) -> bool {
    // `XY` is two status codes from git's fixed set (space means "unmodified in
    // this half"), followed by a space, then the path.
    const CODES: &[char] = &[' ', 'M', 'A', 'D', 'R', 'C', 'U', 'T', '?', '!'];
    let mut chars = line.chars();
    let (Some(x), Some(y), Some(sep)) = (chars.next(), chars.next(), chars.next()) else {
        return false;
    };
    sep == ' ' && CODES.contains(&x) && CODES.contains(&y) && !(x == ' ' && y == ' ')
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
fn ensure_worktree_has_branch(
    repo: &str,
    from_worktree_path: &str,
    branch: &str,
) -> Result<(), String> {
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

fn status_entry_count(worktree: &str) -> Result<usize, String> {
    let raw = run_git_stdout_raw(
        worktree,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let mut records = raw
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    let mut count = 0;
    while let Some(record) = records.next() {
        count += 1;
        // Porcelain v1 -z emits a second NUL field for a rename/copy source.
        if matches!(record.first(), Some(b'R' | b'C')) || matches!(record.get(1), Some(b'R' | b'C'))
        {
            let _ = records.next();
        }
    }
    Ok(count)
}

fn is_dirty(worktree: &str) -> Result<bool, String> {
    Ok(status_entry_count(worktree)? > 0)
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
    let before = stash_tip(worktree)?;
    // A stash commit's oid includes its message, but Git timestamps commits only
    // to the second. Re-applying an existing stash and immediately pushing the
    // same changes with the same message can therefore reproduce the exact oid.
    // Git still cleans the worktree in that case, yet refs/stash does not move.
    // Give every handoff attempt a unique commit message so a successful push
    // always creates a distinct, independently droppable stash entry.
    let message = unique_stash_message(message);
    run_git(
        worktree,
        &["stash", "push", "--include-untracked", "-m", &message],
    )?;
    let after = stash_tip(worktree)?;
    match after {
        Some(oid) if Some(oid.as_str()) != before.as_deref() => Ok(oid),
        _ => Err(
            "Git did not create a stash for these changes. Dirty submodules cannot be carried; commit or stash them inside the submodule first."
                .to_string(),
        ),
    }
}

fn unique_stash_message(message: &str) -> String {
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

fn stash_tip(worktree: &str) -> Result<Option<String>, String> {
    let oid = run_git_allow_exit_codes(
        worktree,
        &["rev-parse", "--verify", "--quiet", "refs/stash"],
        &[1],
    )?;
    Ok((!oid.trim().is_empty()).then(|| oid.trim().to_string()))
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
    let _stash_guard = super::stashes::lock_stash_writes()?;
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
    if let Err(e) = super::head::switch_detached(from, "HEAD") {
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
    if let Err(e) = super::head::switch_branch(to, branch) {
        // Roll back: re-attach the source to its branch, restore both stashes.
        let _ = super::head::switch_branch(from, branch);
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
///
/// `progress` is invoked as each phase *begins* (step ids: `removeWorktree`,
/// `deleteBranch`) so the UI can show a live checklist. The command layer
/// forwards them as `delete-worktree-progress` Tauri events; a lost event only
/// degrades the progress UI.
pub fn delete_branch_with_worktree(
    repo: &str,
    branch: &str,
    from_worktree_path: &str,
    progress: &dyn Fn(&'static str),
) -> Result<String, String> {
    ensure_operand(branch)?;
    ensure_operand(from_worktree_path)?;
    ensure_worktree_has_branch(repo, from_worktree_path, branch)?;
    progress("removeWorktree");
    remove_worktree(repo, from_worktree_path, false)?;
    progress("deleteBranch");
    super::branches::delete_branch(repo, branch, true)?;
    Ok(format!("Deleted {branch} and its worktree"))
}

#[cfg(test)]
mod tests {
    use super::unique_stash_message;

    #[test]
    fn handoff_stash_messages_are_unique_for_identical_attempts() {
        let first = unique_stash_message("GitLane: handoff feature");
        let second = unique_stash_message("GitLane: handoff feature");

        assert_ne!(first, second);
        assert!(first.starts_with("GitLane: handoff feature [GitLane attempt "));
        assert!(second.starts_with("GitLane: handoff feature [GitLane attempt "));
    }
}
