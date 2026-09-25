//! Shorthands for the HEAD-guarded write entry points, leased on the current
//! HEAD — the branch/oid snapshot the UI would send. Tests that exercise an
//! operation's behaviour (not its stale-HEAD refusal) call these, so they run
//! the same entry point the Tauri command does instead of a test-only twin.

use super::super::super::cli::run_git;
use super::super::super::head::current_branch;
use super::*;

/// `(branch, oid)` of HEAD right now: `None` branch when detached, `None` oid
/// when unborn — exactly what `ensure_expected_head` compares against.
pub(in crate::git::write::tests) fn head_lease(repo: &str) -> (Option<String>, Option<String>) {
    let oid = run_git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .ok()
        .map(|out| out.trim().to_string());
    (current_branch(repo), oid)
}

fn head_oid(repo: &str) -> String {
    head_lease(repo).1.expect("HEAD has a commit")
}

pub(in crate::git::write::tests) fn commit(
    repo: &str,
    request: &CommitRequest,
) -> Result<String, String> {
    let (expected_branch, expected_oid) = head_lease(repo);
    commit_expected(
        repo,
        &CommitRequest {
            expected_branch,
            expected_oid,
            ..request.clone()
        },
    )
}

/// Merge local branch `source` into the checked-out branch through
/// `merge_into`, qualified as `refs/heads/<source>` like the store sends it.
pub(in crate::git::write::tests) fn merge(repo: &str, source: &str) -> Result<String, String> {
    let (branch, oid) = head_lease(repo);
    let source = format!("refs/heads/{source}");
    let source_oid = run_git(repo, &["rev-parse", "--verify", &source])?
        .trim()
        .to_string();
    merge_into(
        repo,
        &source,
        &source_oid,
        branch.as_deref(),
        &oid.expect("HEAD has a commit"),
    )
}

pub(in crate::git::write::tests) fn cherry_pick_many(
    repo: &str,
    commits: &[String],
) -> Result<String, String> {
    let branch = head_lease(repo).0;
    cherry_pick_many_onto(repo, branch.as_deref(), &head_oid(repo), commits)
}

pub(in crate::git::write::tests) fn revert_many(
    repo: &str,
    commits: &[String],
) -> Result<String, String> {
    let branch = head_lease(repo).0;
    revert_many_onto(repo, branch.as_deref(), &head_oid(repo), commits)
}

pub(in crate::git::write::tests) fn stash(repo: &str) -> Result<String, String> {
    let (branch, oid) = head_lease(repo);
    stash_expected(repo, branch.as_deref(), oid.as_deref())
}

pub(in crate::git::write::tests) fn stash_paths(
    repo: &str,
    paths: &[String],
) -> Result<String, String> {
    let (branch, oid) = head_lease(repo);
    stash_paths_expected(repo, branch.as_deref(), oid.as_deref(), paths)
}

pub(in crate::git::write::tests) fn stash_apply(repo: &str, oid: &str) -> Result<String, String> {
    let (branch, head) = head_lease(repo);
    stash_apply_onto(repo, branch.as_deref(), head.as_deref(), oid)
}

pub(in crate::git::write::tests) fn stash_pop(repo: &str, oid: &str) -> Result<String, String> {
    let (branch, head) = head_lease(repo);
    stash_pop_onto(repo, branch.as_deref(), head.as_deref(), oid)
}
