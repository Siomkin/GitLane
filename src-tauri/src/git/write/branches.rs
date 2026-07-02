//! Branch, tag, patch, sequencer, and reset operations.

use super::cli::run_git;
use super::operands::{ensure_operand, ensure_opt};

/// Check out an existing branch, tag, or commit.
pub fn checkout(repo: &str, target: &str) -> Result<String, String> {
    ensure_operand(target)?;
    run_git(repo, &["checkout", target])
}

/// Create a branch `name` at `start_point` (defaults to HEAD).
pub fn create_branch(repo: &str, name: &str, start_point: Option<&str>) -> Result<String, String> {
    ensure_operand(name)?;
    ensure_opt(start_point)?;
    match start_point {
        Some(sp) => run_git(repo, &["branch", name, sp]),
        None => run_git(repo, &["branch", name]),
    }
}

/// Delete a local branch. `force` maps to `-D` (drops the merged-safety check).
pub fn delete_branch(repo: &str, name: &str, force: bool) -> Result<String, String> {
    ensure_operand(name)?;
    let flag = if force { "-D" } else { "-d" };
    run_git(repo, &["branch", flag, name])
}

/// Rename a branch.
pub fn rename_branch(repo: &str, old: &str, new: &str) -> Result<String, String> {
    ensure_operand(old)?;
    ensure_operand(new)?;
    run_git(repo, &["branch", "-m", old, new])
}

/// Set the upstream tracking ref for `branch` (`git branch --set-upstream-to`).
/// `upstream` is a remote-tracking ref like `origin/main`; it must already exist.
pub fn set_upstream(repo: &str, branch: &str, upstream: &str) -> Result<String, String> {
    ensure_operand(branch)?;
    ensure_operand(upstream)?;
    let arg = format!("--set-upstream-to={upstream}");
    run_git(repo, &["branch", &arg, branch])
}

/// Merge `branch` into the current HEAD.
pub fn merge(repo: &str, branch: &str) -> Result<String, String> {
    ensure_operand(branch)?;
    run_git(repo, &["merge", branch])
}

/// Fast-forward the current HEAD to `target`. Fails (no merge commit) if the
/// move isn't a fast-forward — callers should only offer this when it is.
pub fn fast_forward(repo: &str, target: &str) -> Result<String, String> {
    ensure_operand(target)?;
    run_git(repo, &["merge", "--ff-only", target])
}

/// Fast-forward a branch that is **not** checked out to `target`, in place,
/// without switching the working tree. `git fetch . <target>:<branch>` updates
/// the local branch ref and — unlike `update-ref` — refuses a non-fast-forward
/// move (no `+` prefix), so it keeps the same FF-only safety as `fast_forward`.
/// Git rejects this on the currently checked-out branch; callers must route the
/// current branch through `fast_forward` instead.
pub fn fast_forward_branch(repo: &str, branch: &str, target: &str) -> Result<String, String> {
    // `git fetch . <target>:<branch>` has no `--` end-of-options guard, so a
    // dash-prefixed target/branch (e.g. `--upload-pack=…`) would be parsed as an
    // option and reach command execution. Reject those operands outright.
    ensure_operand(branch)?;
    ensure_operand(target)?;
    run_git(repo, &["fetch", ".", &format!("{target}:{branch}")])
}

/// Rebase the current HEAD onto `onto`.
pub fn rebase(repo: &str, onto: &str) -> Result<String, String> {
    ensure_operand(onto)?;
    run_git(repo, &["rebase", onto])
}

/// Cherry-pick `commit` onto the current HEAD.
pub fn cherry_pick(repo: &str, commit: &str) -> Result<String, String> {
    ensure_operand(commit)?;
    run_git(repo, &["cherry-pick", commit])
}

/// Cherry-pick several commits onto the current HEAD in one atomic invocation
/// (`git cherry-pick A B C…`). Unlike a client-side loop, a single invocation
/// applies them in order with proper conflict handling — and stops cleanly on
/// the first conflict instead of leaving a half-applied mess mid-loop.
pub fn cherry_pick_many(repo: &str, commits: &[String]) -> Result<String, String> {
    if commits.is_empty() {
        return Err("no commits to cherry-pick".to_string());
    }
    for c in commits {
        ensure_operand(c)?;
    }
    let mut args: Vec<&str> = Vec::with_capacity(commits.len() + 1);
    args.push("cherry-pick");
    for c in commits {
        args.push(c.as_str());
    }
    run_git(repo, &args)
}

/// Revert `commit`, creating a new commit that undoes it.
pub fn revert(repo: &str, commit: &str) -> Result<String, String> {
    ensure_operand(commit)?;
    run_git(repo, &["revert", "--no-edit", commit])
}

/// Revert several commits in one atomic invocation (`git revert --no-edit A B…`).
/// Reverts in the given order; stops on the first conflict.
pub fn revert_many(repo: &str, commits: &[String]) -> Result<String, String> {
    if commits.is_empty() {
        return Err("no commits to revert".to_string());
    }
    for c in commits {
        ensure_operand(c)?;
    }
    let mut args: Vec<&str> = Vec::with_capacity(commits.len() + 2);
    args.push("revert");
    args.push("--no-edit");
    for c in commits {
        args.push(c.as_str());
    }
    run_git(repo, &args)
}

/// Create a lightweight tag `name` at `sha` (defaults to HEAD). Reads back as a
/// `RefLabel` of kind "tag" on the graph.
///
/// `--no-sign` overrides `tag.gpgsign=true`, which would otherwise upgrade the
/// plain `git tag` to a *signed* (annotated) tag — and, with no `-m`, make git
/// launch an editor for the message inside this GUI subprocess and fail. A
/// lightweight tag carries no message or tagger, so there is nothing to sign.
pub fn create_tag(repo: &str, name: &str, sha: Option<&str>) -> Result<String, String> {
    ensure_operand(name)?;
    ensure_opt(sha)?;
    match sha {
        Some(s) => run_git(repo, &["tag", "--no-sign", name, s]),
        None => run_git(repo, &["tag", "--no-sign", name]),
    }
}

/// Create an annotated tag `name` carrying `message` at `sha` (defaults to HEAD).
/// Unlike a lightweight tag this stores a tagger + message, so it shows up in
/// `git tag -n` and can be GPG-signed by the user's config.
pub fn create_annotated_tag(
    repo: &str,
    name: &str,
    message: &str,
    sha: Option<&str>,
) -> Result<String, String> {
    ensure_operand(name)?;
    ensure_opt(sha)?;
    let mut args = vec!["tag", "-a", name, "-m", message];
    if let Some(s) = sha {
        args.push(s);
    }
    run_git(repo, &args)
}

/// Write a patch file for the single commit `sha` into the worktree via
/// `git format-patch -1`. Git names the file `NNNN-<subject>.patch` and prints
/// the path it created, which we return as the success message.
pub fn create_patch(repo: &str, sha: &str) -> Result<String, String> {
    ensure_operand(sha)?;
    run_git(repo, &["format-patch", "-1", sha])
}

/// Reset the current branch to `target`. `mode` is one of soft|mixed|hard.
pub fn reset(repo: &str, target: &str, mode: &str) -> Result<String, String> {
    ensure_operand(target)?;
    let flag = match mode {
        "soft" => "--soft",
        "hard" => "--hard",
        _ => "--mixed",
    };
    run_git(repo, &["reset", flag, target])
}

/// Delete a local tag (`git tag -d <name>`). The tag ref is removed locally
/// only; the remote copy (if any) is untouched — that's
/// [`super::delete_remote_tag`], and while the tag still exists on a remote the
/// next Fetch's `refs/tags/*` import brings it back.
pub fn delete_tag(repo: &str, name: &str) -> Result<String, String> {
    ensure_operand(name)?;
    run_git(repo, &["tag", "-d", name])?;
    Ok(format!("Deleted tag {name}"))
}
