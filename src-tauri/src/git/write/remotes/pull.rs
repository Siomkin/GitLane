//! Pull, and resolving which remote/branch a pull targets.

use super::transport::run_transport;

use super::super::cli::run_git;
use super::super::operands::ensure_operand;
use crate::git::transport_auth::TransportCredential;

/// Fetch the configured upstream, then revalidate the explicit checked-out
/// branch before integrating it. A checkout that lands while the network fetch
/// is running therefore aborts before any local branch is moved.
///
/// Integration is `merge --ff-only FETCH_HEAD`, never `git pull`, so no merge
/// commit is created and the user's `pull.rebase` config cannot turn a
/// divergence into a rebase: it fails, and the user picks merge or rebase from
/// the graph.
pub fn pull_branch(
    repo: &str,
    branch: &str,
    expected_oid: &str,
    remote: &str,
    merge_ref: &str,
    cred: &TransportCredential,
) -> Result<String, String> {
    super::super::head::ensure_expected_head(repo, Some(branch), Some(expected_oid))?;
    ensure_operand(remote)?;
    ensure_operand(merge_ref)?;
    // Fetch stays outside the index mutex so a long network pull does not
    // block local staging. The merge below is what needs the lock.
    run_transport(repo, cred, &["fetch", remote, merge_ref])?;
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    // Re-check under the lock: a checkout that landed while we waited must not
    // integrate FETCH_HEAD onto a different tip than the user asked for.
    super::super::head::ensure_expected_head(repo, Some(branch), Some(expected_oid))?;
    run_git(repo, &["merge", "--ff-only", "FETCH_HEAD"])
}

pub fn branch_pull_target(repo: &str, branch: &str) -> Result<(String, String), String> {
    ensure_operand(branch)?;
    // `--default` makes an unset key a successful empty read while preserving
    // real config failures, so users get the actionable no-upstream message
    // without masking malformed or unreadable configuration.
    let remote = run_git(
        repo,
        &[
            "config",
            "--get",
            "--default",
            "",
            &format!("branch.{branch}.remote"),
        ],
    )?
    .trim()
    .to_string();
    let merge_ref = run_git(
        repo,
        &[
            "config",
            "--get",
            "--default",
            "",
            &format!("branch.{branch}.merge"),
        ],
    )?
    .trim()
    .to_string();
    if remote.is_empty() || merge_ref.is_empty() {
        return Err(format!(
            "Branch '{branch}' has no remote-tracking upstream. Publish it or set an upstream first."
        ));
    }
    ensure_operand(&remote)?;
    ensure_operand(&merge_ref)?;
    Ok((remote, merge_ref))
}
