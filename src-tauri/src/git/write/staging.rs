//! Working-tree staging, discard, and commit writes.

use super::cli::run_git;

/// Stage a single file (also stages deletions).
pub fn stage_file(repo: &str, file: &str) -> Result<String, String> {
    run_git(repo, &["add", "-A", "--", file])
}

/// Unstage a single file, restoring it to its HEAD state in the index.
pub fn unstage_file(repo: &str, file: &str) -> Result<String, String> {
    run_git(repo, &["restore", "--staged", "--", file])
}

/// Unstage several files in one atomic invocation (`git restore --staged -- A B…`)
/// so a partial failure can't leave some of the set staged. Paths follow `--`, so
/// a dash-prefixed path cannot be parsed as a flag.
pub fn unstage_files(repo: &str, files: &[String]) -> Result<String, String> {
    if files.is_empty() {
        return Ok(String::new());
    }
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    args.extend(files.iter().map(String::as_str));
    run_git(repo, &args)
}

/// Discard a single file's working-tree changes, reverting it to its HEAD/index
/// state. When `staged` is set the file is unstaged first, then its worktree
/// copy is restored — so "discard" works whether the change is staged or not.
///
/// Whether the file exists in HEAD decides how it's discarded: a file present in
/// HEAD is restored from it; a *new* file (untracked, or staged but never
/// committed — and every file in an unborn repo) has nothing to restore *to*, so
/// its worktree copy is removed with `git clean` instead. This branch is decided
/// up front from `cat-file`, rather than by catching a `git restore` error — so a
/// genuine restore failure on a committed file (a lock, a permission error)
/// surfaces as an error instead of being silently swallowed by the clean
/// fallback and reported as success.
pub fn discard_file(repo: &str, file: &str, staged: bool) -> Result<String, String> {
    // `cat-file -e HEAD:<path>` exits 0 only when the path resolves in HEAD; it
    // fails for a new path and for an unborn repo (no HEAD at all).
    let in_head = run_git(repo, &["cat-file", "-e", &format!("HEAD:{file}")]).is_ok();

    if staged {
        run_git(repo, &["restore", "--staged", "--", file])?;
    }

    if in_head {
        run_git(repo, &["restore", "--worktree", "--", file])?;
        Ok(format!("Discarded changes in {file}"))
    } else {
        // New file: remove the worktree copy (and any untracked dir it created).
        run_git(repo, &["clean", "-f", "-d", "--", file])?;
        Ok(format!("Discarded {file}"))
    }
}

/// Stage every change in the working tree.
pub fn stage_all(repo: &str) -> Result<String, String> {
    run_git(repo, &["add", "-A"])
}

/// Unstage everything, resetting the index to HEAD.
pub fn unstage_all(repo: &str) -> Result<String, String> {
    run_git(repo, &["reset", "-q", "HEAD"])
}

/// Create a commit. `description` (when non-empty) becomes a second message
/// paragraph; `amend` rewrites the previous commit instead.
///
/// When `name`/`email` are given they are pinned via `-c user.name`/
/// `-c user.email`, which sets **both author and committer** for this one
/// invocation — so a GitLane commit always uses the repo's bound identity
/// regardless of what global/local git config (or another tool) has set.
pub fn commit(
    repo: &str,
    summary: &str,
    description: &str,
    amend: bool,
    name: Option<&str>,
    email: Option<&str>,
) -> Result<String, String> {
    let mut args: Vec<String> = Vec::new();
    if let (Some(n), Some(e)) = (name, email) {
        if !n.is_empty() && !e.is_empty() {
            args.push("-c".into());
            args.push(format!("user.name={n}"));
            args.push("-c".into());
            args.push(format!("user.email={e}"));
        }
    }
    args.push("commit".into());
    if amend {
        args.push("--amend".into());
    }
    args.push("-m".into());
    args.push(summary.into());
    if !description.is_empty() {
        args.push("-m".into());
        args.push(description.into());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(repo, &arg_refs)
}

/// Discard *all* uncommitted changes: reset tracked files to HEAD and remove
/// untracked files/directories (`git reset --hard HEAD` + `git clean -fd`).
/// Irreversible — the frontend gates this behind a confirmation.
///
/// An unborn repo (no HEAD yet) has no commit to reset to, but staged "added"
/// files are tracked in the *index*, so `git clean` alone would leave them
/// behind. Empty the index first (`git read-tree --empty`) so those files become
/// untracked and get cleaned with everything else.
pub fn discard_all(repo: &str) -> Result<String, String> {
    let has_head = run_git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok();
    if has_head {
        run_git(repo, &["reset", "--hard", "HEAD"])?;
    } else {
        run_git(repo, &["read-tree", "--empty"])?;
    }
    run_git(repo, &["clean", "-f", "-d"])?;
    Ok("Discarded all changes".to_string())
}
