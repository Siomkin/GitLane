//! Pull, and resolving which remote/branch a pull targets.

use std::path::Path;

use super::transport::run_transport;

use super::super::cli::run_git;
use super::super::operands::{ensure_exact_oid, ensure_operand};
use super::super::worktrees::worktree_git_dir;
use crate::git::transport_auth::TransportCredential;

/// Fetch the configured upstream, then revalidate the explicit checked-out
/// branch before integrating it. A checkout that lands while the network fetch
/// is running therefore aborts before any local branch is moved.
///
/// Integration is `merge --ff-only <oid>`, never `git pull`, so no merge commit
/// is created and the user's `pull.rebase` config cannot turn a divergence into
/// a rebase: it fails, and the user picks merge or rebase from the graph. The
/// oid is read as soon as the fetch returns, because any other fetch in this
/// worktree rewrites `FETCH_HEAD` during the wait for the index lock.
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
    let fetched = fetched_oid(&worktree_git_dir(repo)?, merge_ref)?;
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    // Re-check under the lock: a checkout that landed while we waited must not
    // integrate the fetched commit onto a different tip than the user asked for.
    super::super::head::ensure_expected_head(repo, Some(branch), Some(expected_oid))?;
    run_git(repo, &["merge", "--ff-only", &fetched])
}

/// The commit `FETCH_HEAD` records for `merge_ref`, from its first for-merge
/// line with that ref's description.
fn fetched_oid(git_dir: &Path, merge_ref: &str) -> Result<String, String> {
    let bytes = std::fs::read(git_dir.join("FETCH_HEAD"))
        .map_err(|error| format!("Failed to read FETCH_HEAD: {error}"))?;
    let text = String::from_utf8_lossy(&bytes);
    let wanted = fetch_head_description(merge_ref);
    let oid = text
        .lines()
        .filter_map(|line| line.split_once("\t\t"))
        .find(|(_, description)| description.starts_with(&wanted))
        .map(|(oid, _)| oid)
        .ok_or_else(|| format!("The fetch did not record {merge_ref}, so nothing was merged."))?;
    ensure_exact_oid(oid)?;
    Ok(oid.to_string())
}

/// How git words `merge_ref` in `FETCH_HEAD`. A `gh pr checkout` branch can
/// track a ref outside `refs/heads/`, such as `refs/pull/1/head`.
fn fetch_head_description(merge_ref: &str) -> String {
    if let Some(name) = merge_ref.strip_prefix("refs/heads/") {
        format!("branch '{name}' of ")
    } else if let Some(name) = merge_ref.strip_prefix("refs/tags/") {
        format!("tag '{name}' of ")
    } else if merge_ref.starts_with("refs/") {
        format!("'{merge_ref}' of ")
    } else {
        format!("branch '{merge_ref}' of ")
    }
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

#[cfg(test)]
mod tests {
    use super::fetched_oid;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn read(tag: &str, contents: &str, merge_ref: &str) -> Result<String, String> {
        let dir =
            std::env::temp_dir().join(format!("gitlane-fetch-head-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("FETCH_HEAD"), contents).unwrap();
        let result = fetched_oid(&dir, merge_ref);
        let _ = std::fs::remove_dir_all(&dir);
        result
    }

    #[test]
    fn picks_the_for_merge_line_of_the_requested_branch() {
        let contents =
            format!("{A}\t\ttag 'main' of u\n{A}\tnot-for-merge\tbranch 'main' of u\n{B}\t\tbranch 'main' of u\n");
        assert_eq!(read("branch", &contents, "refs/heads/main").unwrap(), B);
        assert_eq!(read("short", &contents, "main").unwrap(), B);
    }

    #[test]
    fn a_tag_is_never_taken_for_a_branch() {
        let contents = format!("{A}\t\ttag 'v1' of u\n");
        let error = read("tag-only", &contents, "refs/heads/main").unwrap_err();
        assert!(error.contains("did not record"), "{error}");
    }

    #[test]
    fn a_similarly_named_branch_does_not_match() {
        let contents = format!("{A}\t\tbranch 'main2' of u\n");
        assert!(read("prefix", &contents, "refs/heads/main").is_err());
    }

    #[test]
    fn a_malformed_oid_is_refused() {
        let contents = "not-an-oid\t\tbranch 'main' of u\n";
        assert!(read("bad-oid", contents, "refs/heads/main").is_err());
    }
}
