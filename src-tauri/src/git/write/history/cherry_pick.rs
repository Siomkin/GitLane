//! Cherry-picking one or several commits onto the current HEAD.

use super::super::head::ensure_expected_head;
use super::super::operands::ensure_operand;
use super::commit_runner::run_commit_git_locked;
use super::mergeness::{group_by_mergeness, is_merge_commit};

/// Cherry-pick `commit` onto the current HEAD. Merge commits get `-m 1`, so
/// the applied delta is against the first parent — the branch merged *into*,
/// matching the graph's first-parent lane semantics.
#[cfg(test)]
pub fn cherry_pick(repo: &str, commit: &str) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    ensure_operand(commit)?;
    let _identity_guard = super::super::identity::lock_identity_config(repo)?;
    let identity_args = super::super::identity::pinned_commit_args(repo)?;
    cherry_pick_locked(repo, commit, &identity_args)
}

fn cherry_pick_locked(
    repo: &str,
    commit: &str,
    identity_args: &[String],
) -> Result<String, String> {
    if is_merge_commit(repo, commit)? {
        run_commit_git_locked(repo, identity_args, &["cherry-pick", "-m", "1", commit])
    } else {
        run_commit_git_locked(repo, identity_args, &["cherry-pick", commit])
    }
}

pub fn cherry_pick_onto(
    repo: &str,
    expected_branch: Option<&str>,
    expected_oid: &str,
    commit: &str,
) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    ensure_operand(commit)?;
    let _identity_guard = super::super::identity::lock_identity_config(repo)?;
    let identity_args = super::super::identity::pinned_commit_args(repo)?;
    ensure_expected_head(repo, expected_branch, Some(expected_oid))?;
    cherry_pick_locked(repo, commit, &identity_args)
}

/// Cherry-pick several commits onto the current HEAD in order (`git
/// cherry-pick A B C…`). Unlike a client-side loop, batched invocations apply
/// them with proper conflict handling — and stop cleanly on the first conflict
/// instead of leaving a half-applied mess mid-loop.
///
/// Merge commits need `-m 1` and non-merges reject it, so a mixed selection is
/// split into consecutive same-kind runs, one invocation each. A conflict
/// stops at the failing run: earlier runs stay applied (exactly like git's own
/// sequencer stopping mid-batch), but commits after the failing run are not
/// queued in the sequencer — continue finishes only the current run.
#[cfg(test)]
pub fn cherry_pick_many(repo: &str, commits: &[String]) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    let _identity_guard = super::super::identity::lock_identity_config(repo)?;
    let identity_args = super::super::identity::pinned_commit_args(repo)?;
    cherry_pick_many_locked(repo, commits, &identity_args)
}

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
    let mut outputs: Vec<String> = Vec::new();
    for (merge, run) in group_by_mergeness(repo, commits)? {
        let mut args: Vec<&str> = Vec::with_capacity(run.len() + 3);
        args.push("cherry-pick");
        if merge {
            args.extend(["-m", "1"]);
        }
        args.extend(run);
        outputs.push(run_commit_git_locked(repo, identity_args, &args)?);
    }
    outputs.retain(|o| !o.is_empty());
    Ok(outputs.join("\n"))
}

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
