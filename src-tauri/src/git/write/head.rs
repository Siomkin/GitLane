//! Preconditions for writes whose user-visible subject is a branch/HEAD.
//!
//! Frontend state is only a snapshot. Every history-changing IPC call carries
//! the branch and oid the user acted on; these helpers fail closed when Git no
//! longer matches that snapshot instead of mutating whichever HEAD is current.

use super::cli::run_git;
use super::operands::ensure_operand;

pub(super) fn current_branch(repo: &str) -> Option<String> {
    run_git(repo, &["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .map(|output| output.trim().to_string())
        .filter(|branch| !branch.is_empty())
}

fn resolved_commit(repo: &str, revision: &str) -> Result<String, String> {
    ensure_operand(revision)?;
    let oid = run_git(
        repo,
        &["rev-parse", "--verify", &format!("{revision}^{{commit}}")],
    )?
    .lines()
    .next()
    .unwrap_or("")
    .trim()
    .to_string();
    if oid.is_empty() {
        return Err(format!("Could not resolve {revision} to a commit."));
    }
    Ok(oid)
}

pub(super) fn ensure_commit_exists(repo: &str, revision: &str) -> Result<(), String> {
    resolved_commit(repo, revision).map(|_| ())
}

pub(super) fn ensure_revision_at(
    repo: &str,
    revision: &str,
    expected_oid: &str,
) -> Result<(), String> {
    let actual = resolved_commit(repo, revision)?;
    let expected = resolved_commit(repo, expected_oid)?;
    if actual != expected {
        return Err(format!(
            "{revision} changed from {} to {}. Refresh and try again.",
            short(&expected),
            short(&actual),
        ));
    }
    Ok(())
}

pub(super) fn ensure_expected_head(
    repo: &str,
    expected_branch: Option<&str>,
    expected_oid: Option<&str>,
) -> Result<(), String> {
    let actual_branch = current_branch(repo);
    if actual_branch.as_deref() != expected_branch {
        return Err(format!(
            "HEAD changed from {} to {}. Refresh and try again.",
            describe_branch(expected_branch),
            describe_branch(actual_branch.as_deref()),
        ));
    }

    match expected_oid {
        Some(expected) => ensure_revision_at(repo, "HEAD", expected),
        None => {
            if run_git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok() {
                Err("HEAD gained a commit. Refresh and try again.".to_string())
            } else {
                Ok(())
            }
        }
    }
}

pub(super) fn ensure_expected_branch_tip(
    repo: &str,
    branch: &str,
    expected_oid: &str,
) -> Result<(), String> {
    ensure_operand(branch)?;
    ensure_revision_at(repo, &format!("refs/heads/{branch}"), expected_oid)
}

pub(super) fn checkout_expected_branch(
    repo: &str,
    branch: &str,
    expected_oid: &str,
) -> Result<(), String> {
    ensure_expected_branch_tip(repo, branch, expected_oid)?;
    if current_branch(repo).as_deref() != Some(branch) {
        run_git(repo, &["checkout", branch])?;
    }
    ensure_expected_head(repo, Some(branch), Some(expected_oid))
}

fn describe_branch(branch: Option<&str>) -> String {
    branch
        .map(|name| format!("branch '{name}'"))
        .unwrap_or_else(|| "detached HEAD".to_string())
}

fn short(oid: &str) -> &str {
    &oid[..oid.len().min(7)]
}
