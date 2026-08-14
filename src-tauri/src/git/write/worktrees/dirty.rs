//! What a worktree would lose: the dirty/ignored probe the removal confirm
//! shows, and the cheaper predicates the handoff paths gate on.

use crate::git::types::WorktreeDirtyState;

use super::super::cli::{run_git, run_git_stdout, run_git_stdout_raw};
use super::super::operands::ensure_operand;

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

/// Whether a linked worktree has uncommitted work *right now* — the one bit the
/// graph's dirty dot needs, so a branch checked out elsewhere (or a detached
/// worktree pill) reads as "has unsaved work" without opening it.
///
/// A deliberately cheaper probe than [`worktree_dirty_state`], which this marker
/// would otherwise have reused:
/// - no second `--ignored` call — ignored entries are git-disposable (an
///   *unforced* `worktree remove` deletes them), so dotting a worktree for its
///   `target/` would flag every build directory as unsaved work;
/// - untracked directories stay **collapsed** (`--untracked-files=normal`, not
///   the removal confirm's `=all`): a fresh `node_modules` is one record here
///   rather than fifty thousand, and one record is all the answer needs;
/// - `--no-renames` skips similarity detection nothing here reads.
///
/// Submodules are left to the user's own config (`submodule.<name>.ignore`,
/// `diff.ignoreSubmodules`) rather than forced with `--ignore-submodules=none`.
/// Someone who told git to ignore a submodule is told the same thing here, and
/// — the reason that matters — [`worktree_dirty_state`] doesn't override it
/// either: a dot claiming work the removal confirm then reports as nothing to
/// lose would be worse than honouring the setting in both places.
///
/// Still a `git status` per worktree, so it stays off the worktree-list refresh
/// (see [`WorktreeDirtyState`]'s note) — the frontend fans these out after a
/// full re-sync has already painted, throttled and batched.
pub fn worktree_is_dirty(worktree_path: &str) -> Result<bool, String> {
    ensure_operand(worktree_path)?;
    // stdout only, untrimmed — same reasoning as `worktree_dirty_state`: the
    // combined form would score a git warning as a changed file and dot a clean
    // worktree.
    let raw = run_git_stdout(
        worktree_path,
        &[
            "status",
            "--porcelain",
            "--untracked-files=normal",
            "--no-renames",
        ],
    )?;
    Ok(raw.lines().any(is_porcelain_record))
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
pub(in crate::git::write) fn is_porcelain_record(line: &str) -> bool {
    // `XY` is two status codes from git's fixed set (space means "unmodified in
    // this half"), followed by a space, then the path.
    const CODES: &[char] = &[' ', 'M', 'A', 'D', 'R', 'C', 'U', 'T', '?', '!'];
    let mut chars = line.chars();
    let (Some(x), Some(y), Some(sep)) = (chars.next(), chars.next(), chars.next()) else {
        return false;
    };
    sep == ' ' && CODES.contains(&x) && CODES.contains(&y) && !(x == ' ' && y == ' ')
}

pub(super) fn status_entry_count(worktree: &str) -> Result<usize, String> {
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

pub(super) fn is_dirty(worktree: &str) -> Result<bool, String> {
    Ok(status_entry_count(worktree)? > 0)
}

/// True when the worktree has unmerged (conflicted) index entries.
pub(super) fn has_unmerged(worktree: &str) -> bool {
    run_git(worktree, &["ls-files", "-u"])
        .map(|out| !out.trim().is_empty())
        .unwrap_or(false)
}
