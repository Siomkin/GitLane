//! Whole-file and bulk working-tree staging writes.

use super::cli::{run_git, run_git_literal_paths};
use super::path_guards::has_head;

/// Drop a tracked path from the index while keeping the worktree leaf
/// (`git rm --cached`). The removal is staged; the file becomes untracked on
/// disk. Deliberately omits `-f`: when the index holds content that matches
/// neither HEAD nor the worktree, Git refuses so that unique staged blob is
/// not silently discarded (GL-337 review).
pub fn stop_tracking(repo: &str, file: &str) -> Result<String, String> {
    let _index_guard = super::index_lock::lock_index_writes(repo)?;
    // Prove the path is tracked before mutating — a missing index entry would
    // otherwise surface as a raw `git rm` failure.
    run_git_literal_paths(repo, &["ls-files", "--error-unmatch", "--", file])
        .map_err(|_| format!("{file} is not tracked"))?;
    run_git_literal_paths(repo, &["rm", "--cached", "-q", "--", file])?;
    Ok(format!(
        "Stopped tracking {file}. The file is still on disk; the removal is staged."
    ))
}

/// Stage several literal files in one atomic invocation (`git add -A -- A B…`,
/// also staging deletions) so a folder roll-up can't leave some of the set
/// unstaged. `--` blocks option parsing; literal mode also blocks pathspec magic.
pub fn stage_files(repo: &str, files: &[String]) -> Result<String, String> {
    let _index_guard = super::index_lock::lock_index_writes(repo)?;
    if files.is_empty() {
        return Ok(String::new());
    }
    let mut args: Vec<&str> = vec!["add", "-A", "--"];
    args.extend(files.iter().map(String::as_str));
    run_git_literal_paths(repo, &args)
}

/// Unstage several literal files in one atomic invocation (`git restore --staged
/// -- A B…`) so a partial failure can't leave some of the set staged. `--`
/// blocks options and literal mode blocks pathspec expansion. On an unborn HEAD
/// there is no HEAD state to restore, so the entries are dropped from the index
/// instead (`git rm --cached -f`) — losing the staged snapshot is exactly what
/// unstage means, even when the worktree copy has moved on.
pub fn unstage_files(repo: &str, files: &[String]) -> Result<String, String> {
    let _index_guard = super::index_lock::lock_index_writes(repo)?;
    if files.is_empty() {
        return Ok(String::new());
    }
    let mut args: Vec<&str> = if has_head(repo) {
        vec!["restore", "--staged", "--"]
    } else {
        vec!["rm", "--cached", "-f", "-q", "--"]
    };
    args.extend(files.iter().map(String::as_str));
    run_git_literal_paths(repo, &args)
}

/// Stage every change in the working tree.
pub fn stage_all(repo: &str) -> Result<String, String> {
    let _index_guard = super::index_lock::lock_index_writes(repo)?;
    run_git(repo, &["add", "-A"])
}

/// Unstage everything, resetting the index to HEAD. An unborn HEAD has no
/// commit to reset to, so the index is emptied instead (`git read-tree
/// --empty`), leaving every staged file untracked — the same guard
/// [`discard_all`] uses.
pub fn unstage_all(repo: &str) -> Result<String, String> {
    let _index_guard = super::index_lock::lock_index_writes(repo)?;
    if has_head(repo) {
        run_git(repo, &["reset", "-q", "HEAD"])
    } else {
        run_git(repo, &["read-tree", "--empty"])
    }
}
