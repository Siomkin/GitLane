//! Linked-worktree operations backed by git porcelain.

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

fn ensure_clean_worktree(repo: &str, label: &str) -> Result<(), String> {
    let status = run_git(repo, &["status", "--porcelain"])?;
    if status.trim().is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Cannot move branch because the {label} worktree has uncommitted changes. Commit or stash them first."
        ))
    }
}

/// Re-read the worktree list and confirm `from_worktree_path` is still registered
/// and still has `branch` checked out. The frontend captures the path when its
/// menu opens; an external `git worktree`/checkout in between could move the
/// branch elsewhere (or detach that worktree), so verify against live state and
/// fail closed *before* removing/detaching anything — otherwise we could destroy
/// a clean, unrelated worktree and delete the branch regardless.
fn ensure_worktree_has_branch(repo: &str, from_worktree_path: &str, branch: &str) -> Result<(), String> {
    // Compare on the resolved real path: git's porcelain output canonicalizes
    // (e.g. macOS `/var` → `/private/var`), so a raw string compare against the
    // UI-supplied path can spuriously miss. Fall back to a trimmed compare when a
    // path can't be resolved (e.g. it's already gone).
    let same_path = |a: &str, b: &str| match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a.trim_end_matches('/') == b.trim_end_matches('/'),
    };
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

/// Move `branch` from another linked worktree into `repo`.
///
/// Git only allows a local branch to be checked out in one worktree at a time.
/// To preserve the linked worktree directory while moving the branch back here,
/// detach the source worktree at its current HEAD, then check out the branch in
/// the current worktree. Both worktrees must be clean before either checkout.
pub fn move_branch_to_worktree(
    repo: &str,
    branch: &str,
    from_worktree_path: &str,
) -> Result<String, String> {
    ensure_operand(branch)?;
    ensure_operand(from_worktree_path)?;
    ensure_worktree_has_branch(repo, from_worktree_path, branch)?;
    ensure_clean_worktree(repo, "current")?;
    ensure_clean_worktree(from_worktree_path, "source")?;
    run_git(from_worktree_path, &["checkout", "--detach"])?;
    run_git(repo, &["checkout", branch])?;
    Ok(format!("Moved {branch} to local checkout"))
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
