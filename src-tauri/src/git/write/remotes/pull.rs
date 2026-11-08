//! Pull, and resolving which remote/branch a pull targets.

use std::path::Path;

use super::transport::run_transport;

use super::super::cli::{run_git, run_git_env, run_git_stdout};
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
    let remote_url = run_git_stdout(repo, &["ls-remote", "--get-url", remote])?;
    run_transport(repo, cred, &["fetch", remote, merge_ref])?;
    let fetched = fetched_oid(&worktree_git_dir(repo)?, merge_ref, remote_url.trim())?;
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    // Re-check under the lock: a checkout that landed while we waited must not
    // integrate the fetched commit onto a different tip than the user asked for.
    super::super::head::ensure_expected_head(repo, Some(branch), Some(expected_oid))?;
    // Not the remote: a URL-valued one could carry credentials into the reflog.
    let reflog_action = format!("pull {merge_ref}");
    run_git_env(
        repo,
        &["merge", "--ff-only", &fetched],
        &[("GIT_REFLOG_ACTION", &reflog_action)],
    )
}

/// The commit `FETCH_HEAD` records for `merge_ref` from this remote, from a
/// for-merge line. libgit2's reader isn't used because it can't name
/// `remote-tracking branch` lines and panics on a non-UTF-8 ref.
fn fetched_oid(git_dir: &Path, merge_ref: &str, remote_url: &str) -> Result<String, String> {
    let bytes = std::fs::read(git_dir.join("FETCH_HEAD"))
        .map_err(|error| format!("Failed to read FETCH_HEAD: {error}"))?;
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<(&str, String, &str)> = text
        .lines()
        .filter_map(|line| line.split_once("\t\t"))
        .map(|(oid, description)| {
            let (name, url) = parse_description(description);
            (oid, name, url)
        })
        .filter(|(_, _, url)| same_remote(remote_url, url))
        .collect();
    let oid = ref_candidates(merge_ref)
        .iter()
        .find_map(|wanted| lines.iter().find(|(_, name, _)| name == wanted))
        .map(|(oid, _, _)| *oid)
        .ok_or_else(|| {
            format!(
                "Couldn't confirm what was fetched for {merge_ref}, so nothing was merged. \
                 Another fetch may have replaced FETCH_HEAD; run the pull once more."
            )
        })?;
    ensure_exact_oid(oid)?;
    Ok(oid.to_string())
}

/// The full ref name and URL in a `FETCH_HEAD` description, in the forms
/// git's `store_updated_refs` writes. `HEAD` is the only ref with no quoted name.
fn parse_description(description: &str) -> (String, &str) {
    for (prefix, namespace) in [
        ("branch '", "refs/heads/"),
        ("tag '", "refs/tags/"),
        ("remote-tracking branch '", "refs/remotes/"),
        ("'", ""),
    ] {
        if let Some((name, url)) = description
            .strip_prefix(prefix)
            .and_then(|rest| rest.split_once("' of "))
        {
            return (format!("{namespace}{name}"), url);
        }
    }
    ("HEAD".to_string(), description)
}

/// The full names `merge_ref` can have, a branch first so that a tag with the
/// same short name can't take its place.
fn ref_candidates(merge_ref: &str) -> Vec<String> {
    if merge_ref == "HEAD" || merge_ref.starts_with("refs/") {
        return vec![merge_ref.to_string()];
    }
    ["refs/heads/", "refs/tags/", "refs/", "refs/remotes/"]
        .iter()
        .map(|namespace| format!("{namespace}{merge_ref}"))
        .collect()
}

/// Whether `recorded` is `url` as git writes it in `FETCH_HEAD`: credentials
/// removed, and a trailing slash or `.git` dropped.
fn same_remote(url: &str, recorded: &str) -> bool {
    fn trimmed(url: &str) -> &str {
        let url = url.trim_end_matches('/');
        url.strip_suffix(".git").unwrap_or(url)
    }
    let recorded = trimmed(recorded);
    recorded == trimmed(url)
        || url.split_once('@').is_some_and(|(before, after)| {
            let scheme = before.find("://").map_or("", |end| &before[..end + 3]);
            recorded == trimmed(&format!("{scheme}{after}"))
        })
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
    use super::{fetched_oid, same_remote};

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn read(tag: &str, contents: &str, merge_ref: &str) -> Result<String, String> {
        let dir =
            std::env::temp_dir().join(format!("gitlane-fetch-head-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("FETCH_HEAD"), contents).unwrap();
        let result = fetched_oid(&dir, merge_ref, "u");
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
        assert!(error.contains("nothing was merged"), "{error}");
    }

    #[test]
    fn a_similarly_named_branch_does_not_match() {
        let contents = format!("{A}\t\tbranch 'main2' of u\n");
        assert!(read("prefix", &contents, "refs/heads/main").is_err());
    }

    #[test]
    fn a_line_from_another_remote_does_not_match() {
        let contents = format!("{A}\t\tbranch 'main' of other\n");
        assert!(read("other-remote", &contents, "refs/heads/main").is_err());
    }

    #[test]
    fn urls_compare_the_way_git_records_them() {
        for (url, recorded) in [
            ("https://me:secret@host/a/b.git", "https://host/a/b"),
            ("git@host:a/b.git", "host:a/b"),
            ("ssh://git@host/a/b/", "ssh://host/a/b"),
            ("/srv/me@work/a.git", "/srv/me@work/a"),
            (".", "."),
        ] {
            assert!(same_remote(url, recorded), "{url}");
        }
        assert!(!same_remote("https://host/a", "https://host/b"));
    }

    #[test]
    fn a_malformed_oid_is_refused() {
        let contents = "not-an-oid\t\tbranch 'main' of u\n";
        assert!(read("bad-oid", contents, "refs/heads/main").is_err());
    }
}
