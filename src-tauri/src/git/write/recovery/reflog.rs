//! Reflog-backed recovery points: the entries the recovery UI lists, and
//! the selector timestamp each one resolves through.

use super::refs::short_oid;
use crate::git::types::ReflogEntry;

use super::super::cli::{run_git, run_git_allow_exit_codes};

/// Recent reflog entries for HEAD and local branches. Uses `git log -g` rather
/// than libgit2 because the CLI's reflog selectors (`HEAD@{1}`) are exactly what
/// users recognise when recovering from a bad reset/checkout.
pub fn reflog_entries(repo: &str, limit: usize) -> Result<Vec<ReflogEntry>, String> {
    run_git(repo, &["rev-parse", "--git-dir"])?;
    let head = run_git_allow_exit_codes(repo, &["rev-parse", "--verify", "--quiet", "HEAD"], &[1])?;
    let branch = run_git(
        repo,
        &[
            "for-each-ref",
            "--count=1",
            "--format=%(refname)",
            "refs/heads",
        ],
    )?;
    if head.trim().is_empty() && branch.trim().is_empty() {
        return Ok(Vec::new());
    }
    let max_count = format!("--max-count={}", limit.max(1));
    // Walk HEAD and local-branch reflogs explicitly instead of `--all`: the dialog
    // is "HEAD and branch movements", and scoping the walk means `--max-count` is
    // spent on recovery entries rather than being eaten by remote-tracking / tag /
    // stash reflogs that `--all` would include (which could starve the list in a
    // fetch-heavy repo). GL-42 review.
    let mut args = vec!["log", "-g"];
    if !head.trim().is_empty() {
        args.push("HEAD");
    }
    args.extend([
        "--branches",
        "--date=unix",
        &max_count,
        "--format=%H%x1f%gd%x1f%gD%x1f%gs%x1f%gn%x1f%ge%x1f%ct",
    ]);
    let raw = run_git(repo, &args)?;
    Ok(raw
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(7, '\u{1f}');
            let oid = parts.next()?.to_string();
            let short_selector = parts.next().unwrap_or("").to_string();
            let selector = parts.next().unwrap_or("").to_string();
            let subject = parts.next().unwrap_or("").to_string();
            let committer_name = parts.next().unwrap_or("").to_string();
            let committer_email = parts.next().unwrap_or("").to_string();
            let commit_timestamp = parts
                .next()
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
            let selector_for_ref = if selector.is_empty() {
                &short_selector
            } else {
                &selector
            };
            let timestamp = reflog_selector_timestamp(selector_for_ref).unwrap_or(commit_timestamp);
            let ref_name = selector_for_ref
                .split("@{")
                .next()
                .unwrap_or("")
                .trim_start_matches("refs/heads/")
                .to_string();
            Some(ReflogEntry {
                short_oid: short_oid(&oid),
                oid,
                selector,
                short_selector,
                ref_name,
                subject,
                committer_name,
                committer_email,
                timestamp,
            })
        })
        .collect())
}

fn reflog_selector_timestamp(selector: &str) -> Option<i64> {
    let start = selector.rfind("@{")? + 2;
    let end = selector[start..].find('}')? + start;
    selector[start..end].parse().ok()
}
