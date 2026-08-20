//! The Bitbucket Cloud pull-request operations (GL-141), written once against the
//! [`BitbucketApi`] transport.
//!
//! Each function builds a Bitbucket REST 2.0 path, runs it through the transport,
//! and maps the JSON into the shared PR DTOs via [`super::dto`]. Unlike GitLab,
//! Bitbucket's `/diff` endpoint returns a ready-made git patch, so [`pr_diff`]
//! feeds it straight to the GitHub provider's battle-tested unified-diff parser —
//! no per-file reconstruction. Only the five basic actions in scope are
//! implemented; everything else returns an explicit "not supported yet".

use serde_json::json;

use super::super::diff::parse_unified_diff;
use super::super::domain::GithubError;
use super::dto::{BitbucketCommit, BitbucketDiffStat, BitbucketPage, BitbucketPr};
use super::transport::BitbucketApi;
use crate::git::types::{FileDiff, PrCommit, PrCommitList, PullRequestDetail, PullRequestSummary};

/// Bitbucket Cloud caps `pagelen` at 50; use the max and a hard page cap as a
/// runaway guard (50 × 40 pages = 2000 items, far beyond any real PR).
const PER_PAGE: usize = 50;
const MAX_PAGES: usize = 40;

/// List pull requests (most recent 50, newest first) for the repo. All states are
/// requested explicitly (`state` repeated) so the list is state-complete —
/// matching `gh pr list --state all` — regardless of the endpoint's OPEN default.
pub fn list_prs(
    api: &dyn BitbucketApi,
    repo: &str,
) -> Result<Vec<PullRequestSummary>, GithubError> {
    let path = format!(
        "{repo}/pullrequests?state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&pagelen={PER_PAGE}&sort=-created_on"
    );
    let raw = api.get("list pull requests", &path)?;
    let page: BitbucketPage<BitbucketPr> = parse(&raw, "pull request list")?;
    Ok(page
        .values
        .into_iter()
        .map(BitbucketPr::into_summary)
        .collect())
}

/// Fetch one pull request's detail plus its changed-file list and diff stats.
pub fn pr_detail(
    api: &dyn BitbucketApi,
    repo: &str,
    number: u64,
) -> Result<PullRequestDetail, GithubError> {
    let path = format!("{repo}/pullrequests/{number}");
    let raw = api.get("pull request detail", &path)?;
    let pr: BitbucketPr = parse(&raw, "pull request detail")?;

    // The PR object carries no diff stats, so derive the file list and aggregate
    // additions/deletions from the reconciled `/diff` + `/diffstat` reads.
    let diffs = pr_diff(api, repo, number)?;
    let files: Vec<String> = diffs.iter().map(|d| d.path.clone()).collect();
    let additions: u64 = diffs.iter().map(|d| d.add as u64).sum();
    let deletions: u64 = diffs.iter().map(|d| d.del as u64).sum();

    Ok(pr.into_detail(files, additions, deletions, Vec::new()))
}

/// Full diff of a pull request, parsed into per-file [`FileDiff`] so the shared
/// diff viewer renders it unchanged. The paginated `/diffstat` is reconciled
/// with the raw patch because Bitbucket can elide patch bodies at its own
/// per-file, total-line, and file-count limits below our transport byte cap.
pub fn pr_diff(
    api: &dyn BitbucketApi,
    repo: &str,
    number: u64,
) -> Result<Vec<FileDiff>, GithubError> {
    let path = format!("{repo}/pullrequests/{number}/diff");
    // The `/diff` endpoint returns a raw git patch, not JSON — request text/plain
    // so Bitbucket does not answer 406 (see `BitbucketApi::get_text`).
    let patch = api.get_text("pull request diff", &path)?;
    let mut files = parse_unified_diff(&patch);
    let stats = diff_stats(api, repo, number)?;
    for stat in stats.values {
        let path = stat.path();
        if path.is_empty() {
            continue;
        }
        if let Some(file) = files.iter_mut().find(|file| file.path == path) {
            if let Some(add) = stat
                .lines_added
                .map(|count| usize::try_from(count).unwrap_or(usize::MAX))
            {
                if file.add != add {
                    file.truncated = true;
                }
                file.add = file.add.max(add);
            }
            if let Some(del) = stat
                .lines_removed
                .map(|count| usize::try_from(count).unwrap_or(usize::MAX))
            {
                if file.del != del {
                    file.truncated = true;
                }
                file.del = file.del.max(del);
            }
        } else {
            files.push(FileDiff {
                path: path.to_string(),
                status: stat.file_status(),
                add: stat
                    .lines_added
                    .map(|count| usize::try_from(count).unwrap_or(usize::MAX))
                    .unwrap_or(0),
                del: stat
                    .lines_removed
                    .map(|count| usize::try_from(count).unwrap_or(usize::MAX))
                    .unwrap_or(0),
                truncated: true,
                ..Default::default()
            });
        }
    }
    if stats.capped {
        eprintln!(
            "gitlane: Bitbucket PR #{number} diff stats hit the {MAX_PAGES}-page cap; the bounded diff is marked incomplete"
        );
        for file in &mut files {
            file.truncated = true;
        }
    }
    Ok(files)
}

struct DiffStatsResult {
    values: Vec<BitbucketDiffStat>,
    capped: bool,
}

fn diff_stats(
    api: &dyn BitbucketApi,
    repo: &str,
    number: u64,
) -> Result<DiffStatsResult, GithubError> {
    let mut stats = Vec::new();
    let resource = format!("{repo}/pullrequests/{number}/diffstat");
    let mut path = format!(
        "{resource}?pagelen={PER_PAGE}&fields=values.status,values.lines_added,values.lines_removed,values.old.path,values.new.path,next"
    );
    for _ in 0..MAX_PAGES {
        let raw = api.get("pull request diff stats", &path)?;
        let batch: BitbucketPage<BitbucketDiffStat> = parse(&raw, "pull request diff stats")?;
        stats.extend(batch.values);
        match batch.next {
            Some(next) => path = validated_next_path(&next, &resource)?,
            None => {
                return Ok(DiffStatsResult {
                    values: stats,
                    capped: false,
                })
            }
        }
    }
    Ok(DiffStatsResult {
        values: stats,
        capped: true,
    })
}

fn validated_next_path(next: &str, expected_resource: &str) -> Result<String, GithubError> {
    const API_PREFIX: &str = "https://api.bitbucket.org/2.0/";
    let path = next.strip_prefix(API_PREFIX).ok_or_else(|| {
        GithubError::InvalidResponse(
            "Bitbucket pagination returned a continuation outside api.bitbucket.org.".to_string(),
        )
    })?;
    let resource = path.split_once('?').map_or(path, |(resource, _)| resource);
    // Compared case-insensitively: `expected_resource` carries the workspace and
    // slug exactly as the user's remote spells them, while Bitbucket may
    // canonicalize the case in the `next` link it returns. Bitbucket routes
    // these paths case-insensitively, so an exact match would reject a
    // legitimate continuation and fail every page past the first. The origin is
    // pinned by the API_PREFIX check above and the base is re-applied from a
    // constant when the request is issued, so this only relaxes *which* resource
    // under the already-fixed host the cursor may name.
    if !resource.eq_ignore_ascii_case(expected_resource) {
        return Err(GithubError::InvalidResponse(
            "Bitbucket pagination returned a continuation for a different resource.".to_string(),
        ));
    }
    Ok(path.to_string())
}

/// The pull request's commit list (`/commits`), paginated so a large PR keeps
/// every commit (parity with the gh provider's full commit read).
pub fn pr_commits(
    api: &dyn BitbucketApi,
    repo: &str,
    number: u64,
) -> Result<PrCommitList, GithubError> {
    let mut commits: Vec<PrCommit> = Vec::new();
    let resource = format!("{repo}/pullrequests/{number}/commits");
    let mut path = format!("{resource}?pagelen={PER_PAGE}");
    for _ in 0..MAX_PAGES {
        let raw = api.get("pull request commits", &path)?;
        let batch: BitbucketPage<BitbucketCommit> = parse(&raw, "pull request commits")?;
        commits.extend(batch.values.into_iter().map(BitbucketCommit::into_commit));
        match batch.next {
            Some(next) => path = validated_next_path(&next, &resource)?,
            None => {
                return Ok(PrCommitList {
                    commits,
                    truncated: false,
                });
            }
        }
    }
    eprintln!(
        "gitlane: Bitbucket PR #{number} commits hit the {MAX_PAGES}-page cap; {} fetched, later commits omitted",
        commits.len()
    );
    Ok(PrCommitList {
        commits,
        truncated: true,
    })
}

/// Open a new pull request from `head` into `base`. Returns the new PR's web URL.
pub fn create_pr(
    api: &dyn BitbucketApi,
    repo: &str,
    base: &str,
    head: &str,
    title: &str,
    body: &str,
    draft: bool,
) -> Result<String, GithubError> {
    if title.trim().is_empty() {
        return Err(GithubError::CommandFailed(
            "A title is required to open a pull request.".to_string(),
        ));
    }
    let payload = json!({
        "title": title,
        "source": { "branch": { "name": head } },
        "destination": { "branch": { "name": base } },
        "description": body,
        "draft": draft,
    });
    let path = format!("{repo}/pullrequests");
    let raw = api.post_json("create pull request", &path, &payload.to_string())?;
    let pr: BitbucketPr = parse(&raw, "created pull request")?;
    let summary = pr.into_summary();
    Ok(if summary.url.is_empty() {
        format!("Opened pull request #{}", summary.number)
    } else {
        summary.url
    })
}

/// Merge a pull request. `method` maps to Bitbucket's merge strategy: "merge" →
/// `merge_commit`, "squash" → `squash`. Bitbucket's third strategy is
/// `fast_forward`, not a rebase-merge, so "rebase" is refused explicitly (parity
/// with the GitLab provider). `delete_branch` removes the source branch.
pub fn merge_pr(
    api: &dyn BitbucketApi,
    repo: &str,
    number: u64,
    method: &str,
    delete_branch: bool,
) -> Result<String, GithubError> {
    let strategy = match method {
        "squash" => "squash",
        "merge" | "" => "merge_commit",
        "rebase" => return Err(unsupported(
            "Rebase-and-merge isn't supported for Bitbucket pull requests. Use Merge or Squash.",
        )),
        other => {
            return Err(GithubError::CommandFailed(format!(
                "Unknown merge method '{other}' for Bitbucket."
            )))
        }
    };
    let payload = json!({
        "merge_strategy": strategy,
        "close_source_branch": delete_branch,
    });
    let path = format!("{repo}/pullrequests/{number}/merge");
    let raw = api.post_json("merge pull request", &path, &payload.to_string())?;
    // The merge response is the updated PR object; surface its URL when present.
    let url = parse::<BitbucketPr>(&raw, "merged pull request")
        .ok()
        .map(|pr| pr.into_summary().url)
        .filter(|u| !u.is_empty());
    Ok(url.unwrap_or_else(|| format!("Merged #{number}")))
}

/// Approve a pull request without authored text.
pub fn approve_pr(api: &dyn BitbucketApi, repo: &str, number: u64) -> Result<String, GithubError> {
    let path = format!("{repo}/pullrequests/{number}/approve");
    // The approve endpoint takes no body; send an empty JSON object.
    api.post_json("approve pull request", &path, "{}")?;
    Ok(format!("Approved #{number}"))
}

/// A "not supported yet" error for an out-of-scope option on an operation this
/// provider does implement (an unsupported merge method or review action).
/// Whole operations decline through the trait's default (GL-354).
fn unsupported(message: &str) -> GithubError {
    GithubError::CommandFailed(message.to_string())
}

/// The repo base path for a Bitbucket REST URL: `repositories/{workspace}/{slug}`
/// with each segment percent-encoded. Workspace/slug are normally URL-safe, but
/// encoding defends against an unexpected character breaking the path.
pub fn repo_path(workspace: &str, slug: &str) -> String {
    if workspace.is_empty() {
        format!("repositories/{}", percent_encode(slug))
    } else {
        format!(
            "repositories/{}/{}",
            percent_encode(workspace),
            percent_encode(slug)
        )
    }
}

/// Parse a JSON body into `T`, mapping a failure to an `InvalidResponse` category
/// with the operation label (never echoing the raw body, which could be large).
fn parse<T: serde::de::DeserializeOwned>(raw: &str, what: &str) -> Result<T, GithubError> {
    serde_json::from_str(raw)
        .map_err(|e| GithubError::InvalidResponse(format!("failed to parse {what}: {e}")))
}

/// Percent-encode everything outside the RFC 3986 unreserved set.
fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests;
