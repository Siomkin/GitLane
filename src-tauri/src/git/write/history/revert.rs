//! Reverting one or several commits on the current HEAD.

use super::super::head::ensure_expected_head;
use super::super::operands::ensure_operand;
use super::commit_runner::run_commit_git_locked;
use super::mergeness::uniform_mergeness;

fn revert_many_locked(
    repo: &str,
    commits: &[String],
    identity_args: &[String],
) -> Result<String, String> {
    if commits.is_empty() {
        return Err("no commits to revert".to_string());
    }
    for c in commits {
        ensure_operand(c)?;
    }
    let merge = uniform_mergeness(repo, commits)?;
    let mut args: Vec<&str> = Vec::with_capacity(commits.len() + 4);
    args.push("revert");
    args.push("--no-edit");
    if merge {
        args.extend(["-m", "1"]);
    }
    args.extend(commits.iter().map(String::as_str));
    run_commit_git_locked(repo, identity_args, &args)
}

/// Revert several commits in order (`git revert --no-edit A B…`) once HEAD
/// still matches the branch/oid the user saw; stops on the first conflict.
/// Merge commits get `-m 1`: the revert undoes what the merge brought in
/// relative to its first parent — the branch merged *into*, matching the
/// graph's first-parent lane semantics. As in `cherry_pick_many_onto`, a
/// selection mixing merges and non-merges is refused up front.
pub fn revert_many_onto(
    repo: &str,
    expected_branch: Option<&str>,
    expected_oid: &str,
    commits: &[String],
) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    let _identity_guard = super::super::identity::lock_identity_config(repo)?;
    let identity_args = super::super::identity::pinned_commit_args(repo)?;
    ensure_expected_head(repo, expected_branch, Some(expected_oid))?;
    revert_many_locked(repo, commits, &identity_args)
}
