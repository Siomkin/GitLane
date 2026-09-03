//! Reverting one or several commits on the current HEAD.

use super::super::head::ensure_expected_head;
use super::super::operands::ensure_operand;
use super::commit_runner::run_commit_git_locked;
use super::mergeness::group_by_mergeness;
// The single-commit path is the test-only twin of the batched one below.
#[cfg(test)]
use super::mergeness::is_merge_commit;

/// Revert `commit`, creating a new commit that undoes it. Merge commits get
/// `-m 1`: the revert undoes what the merge brought in relative to its first
/// parent — the branch merged *into*, matching the graph's first-parent lane
/// semantics.
#[cfg(test)]
pub fn revert(repo: &str, commit: &str) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    ensure_operand(commit)?;
    let _identity_guard = super::super::identity::lock_identity_config(repo)?;
    let identity_args = super::super::identity::pinned_commit_args(repo)?;
    revert_locked(repo, commit, &identity_args)
}

#[cfg(test)]
fn revert_locked(repo: &str, commit: &str, identity_args: &[String]) -> Result<String, String> {
    if is_merge_commit(repo, commit)? {
        run_commit_git_locked(
            repo,
            identity_args,
            &["revert", "--no-edit", "-m", "1", commit],
        )
    } else {
        run_commit_git_locked(repo, identity_args, &["revert", "--no-edit", commit])
    }
}

/// Revert several commits in order (`git revert --no-edit A B…`); stops on the
/// first conflict. Same split as [`cherry_pick_many`]: merge commits need
/// `-m 1` and non-merges reject it, so mixed selections run as consecutive
/// same-kind invocations, and a conflict leaves earlier runs applied without
/// queueing the later ones.
#[cfg(test)]
pub fn revert_many(repo: &str, commits: &[String]) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    let _identity_guard = super::super::identity::lock_identity_config(repo)?;
    let identity_args = super::super::identity::pinned_commit_args(repo)?;
    revert_many_locked(repo, commits, &identity_args)
}

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
    let mut outputs: Vec<String> = Vec::new();
    for (merge, run) in group_by_mergeness(repo, commits)? {
        let mut args: Vec<&str> = Vec::with_capacity(run.len() + 4);
        args.push("revert");
        args.push("--no-edit");
        if merge {
            args.extend(["-m", "1"]);
        }
        args.extend(run);
        outputs.push(run_commit_git_locked(repo, identity_args, &args)?);
    }
    outputs.retain(|o| !o.is_empty());
    Ok(outputs.join("\n"))
}

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
