//! Cherry-picking one or several commits onto the current HEAD.

use super::super::head::ensure_expected_head;
use super::super::operands::ensure_operand;
use super::commit_runner::run_commit_git_locked;
use super::mergeness::uniform_mergeness;

fn cherry_pick_many_locked(
    repo: &str,
    commits: &[String],
    identity_args: &[String],
) -> Result<String, String> {
    if commits.is_empty() {
        return Err("no commits to cherry-pick".to_string());
    }
    for c in commits {
        ensure_operand(c)?;
    }
    let merge = uniform_mergeness(repo, commits)?;
    let mut args: Vec<&str> = Vec::with_capacity(commits.len() + 3);
    args.push("cherry-pick");
    if merge {
        args.extend(["-m", "1"]);
    }
    args.extend(commits.iter().map(String::as_str));
    run_commit_git_locked(repo, identity_args, &args)
}

/// Cherry-pick several commits onto HEAD in order (`git cherry-pick A B C…`),
/// once HEAD still matches the branch/oid the user saw. One batched invocation
/// applies them with git's own conflict handling and stops cleanly on the
/// first conflict instead of leaving a half-applied mess mid-loop.
///
/// Merge commits get `-m 1`, so the applied delta is against the first parent
/// — the branch merged *into*, matching the graph's first-parent lane
/// semantics. Non-merges reject `-m`, so a selection mixing the two is refused
/// up front (`uniform_mergeness`) rather than split into runs a mid-batch
/// conflict would leave half-queued.
pub fn cherry_pick_many_onto(
    repo: &str,
    expected_branch: Option<&str>,
    expected_oid: &str,
    commits: &[String],
) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    let _identity_guard = super::super::identity::lock_identity_config(repo)?;
    let identity_args = super::super::identity::pinned_commit_args(repo)?;
    ensure_expected_head(repo, expected_branch, Some(expected_oid))?;
    cherry_pick_many_locked(repo, commits, &identity_args)
}
