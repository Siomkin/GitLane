//! Bitbucket Cloud REST 2.0 response shapes and their mapping to the shared PR
//! DTOs (GL-141).
//!
//! Bitbucket's pull-request JSON is reshaped into the same [`crate::git::types`]
//! `PullRequest*` types the GitHub provider emits, so the existing PR list/detail
//! UI renders Bitbucket PRs unchanged. Only the fields Bitbucket actually returns
//! on the PR endpoints are mapped; aggregate diff stats (additions/deletions/
//! changed files) are computed from the parsed `/diff` patch by the caller, not
//! carried on the PR object. Every conversion here is pure and unit-tested — the
//! transport is a separate concern.

use serde::Deserialize;

use crate::git::types::{ChangeStatus, PrAuthor, PrCommit, PullRequestDetail, PullRequestSummary};

/// A Bitbucket paginated collection. `next` is an opaque server-provided URL;
/// callers that need every page validate and follow it instead of inferring
/// completion from page length.
#[derive(Debug, Clone, Deserialize)]
pub struct BitbucketPage<T> {
    #[serde(default = "Vec::new")]
    pub values: Vec<T>,
    #[serde(default)]
    pub next: Option<String>,
}

/// One `/diffstat` row. The stat endpoint remains paginated when the raw patch
/// hits Bitbucket's rendering limits, so it is the completeness oracle for the
/// patch and supplies exact totals for any elided file body.
#[derive(Debug, Clone, Deserialize)]
pub struct BitbucketDiffStat {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub lines_added: Option<u64>,
    #[serde(default)]
    pub lines_removed: Option<u64>,
    #[serde(default)]
    pub old: Option<BitbucketDiffPath>,
    #[serde(default)]
    pub new: Option<BitbucketDiffPath>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BitbucketDiffPath {
    #[serde(default)]
    pub path: String,
}

impl BitbucketDiffStat {
    pub fn path(&self) -> &str {
        self.new
            .as_ref()
            .filter(|side| !side.path.is_empty())
            .or(self.old.as_ref())
            .map(|side| side.path.as_str())
            .unwrap_or_default()
    }

    pub fn file_status(&self) -> ChangeStatus {
        match self.status.as_str() {
            "added" => ChangeStatus::Added,
            "removed" => ChangeStatus::Deleted,
            "renamed" => ChangeStatus::Renamed,
            _ => ChangeStatus::Modified,
        }
    }
}

/// A Bitbucket user reference (`author`, `reviewers[]`, commit `author.user`).
/// Bitbucket dropped the legacy `username`; identity comes from `nickname` /
/// `account_id` / `display_name`.
#[derive(Debug, Clone, Deserialize)]
pub struct BitbucketUser {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub nickname: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
}

impl BitbucketUser {
    pub fn into_author(self) -> PrAuthor {
        let login = first_non_empty([self.nickname, self.account_id.clone()])
            .or_else(|| self.display_name.clone())
            .unwrap_or_default();
        let name = self
            .display_name
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| login.clone());
        PrAuthor { login, name }
    }
}

/// One endpoint of a PR: `{ "branch": { "name": "main" } }`.
#[derive(Debug, Clone, Deserialize)]
pub struct BitbucketEndpoint {
    #[serde(default)]
    pub branch: Option<BitbucketBranch>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BitbucketBranch {
    #[serde(default)]
    pub name: String,
}

impl BitbucketEndpoint {
    fn branch_name(&self) -> String {
        self.branch
            .as_ref()
            .map(|b| b.name.clone())
            .unwrap_or_default()
    }
}

/// Bitbucket renders the PR description as `{ "raw": "...", "html": "..." }`.
#[derive(Debug, Clone, Deserialize)]
pub struct BitbucketRendered {
    #[serde(default)]
    pub raw: String,
}

/// The `links` block; only the `html` self-link (the PR web URL) is used.
#[derive(Debug, Clone, Deserialize)]
pub struct BitbucketLinks {
    #[serde(default)]
    pub html: Option<BitbucketLink>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BitbucketLink {
    #[serde(default)]
    pub href: String,
}

/// A Bitbucket pull request as returned by the list and single-PR endpoints.
#[derive(Debug, Clone, Deserialize)]
pub struct BitbucketPr {
    pub id: u64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub created_on: String,
    #[serde(default)]
    pub source: Option<BitbucketEndpoint>,
    #[serde(default)]
    pub destination: Option<BitbucketEndpoint>,
    #[serde(default)]
    pub author: Option<BitbucketUser>,
    /// Raw markdown body. Newer responses carry it under `summary.raw`; a
    /// top-level `description` is accepted too so either shape yields the body.
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub summary: Option<BitbucketRendered>,
    #[serde(default)]
    pub links: Option<BitbucketLinks>,
    #[serde(default)]
    pub reviewers: Vec<BitbucketUser>,
    #[serde(default)]
    pub comment_count: u64,
}

impl BitbucketPr {
    fn author_or_default(&self) -> PrAuthor {
        self.author
            .clone()
            .map(BitbucketUser::into_author)
            .unwrap_or_else(|| PrAuthor {
                login: String::new(),
                name: String::new(),
            })
    }

    fn head_ref(&self) -> String {
        self.source
            .as_ref()
            .map(BitbucketEndpoint::branch_name)
            .unwrap_or_default()
    }

    fn base_ref(&self) -> String {
        self.destination
            .as_ref()
            .map(BitbucketEndpoint::branch_name)
            .unwrap_or_default()
    }

    fn web_url(&self) -> String {
        self.links
            .as_ref()
            .and_then(|l| l.html.as_ref())
            .map(|h| h.href.clone())
            .unwrap_or_default()
    }

    fn body(&self) -> String {
        first_non_empty([
            self.description.clone(),
            self.summary.as_ref().map(|s| s.raw.clone()),
        ])
        .unwrap_or_default()
    }

    /// Map to the shared summary. The list endpoint carries no diff stats, so
    /// additions/deletions/changed files are zero here; the detail view fills
    /// them from the parsed `/diff`.
    pub fn into_summary(self) -> PullRequestSummary {
        PullRequestSummary {
            number: self.id,
            state: map_state(&self.state),
            // Bitbucket's PR object exposes no simple mergeability verdict, so
            // leave it empty (the UI treats "" as "unknown / not offered").
            mergeable: String::new(),
            head_ref: self.head_ref(),
            base_ref: self.base_ref(),
            author: self.author_or_default(),
            created_at: self.created_on.clone(),
            is_draft: self.draft,
            url: self.web_url(),
            additions: 0,
            deletions: 0,
            changed_files: 0,
            title: self.title,
        }
    }

    /// Map to the shared detail. `files`/`additions`/`deletions`/`changed_files`
    /// are computed by the caller from the parsed `/diff`; `commits` is fetched
    /// separately (empty until the Commits tab loads it).
    pub fn into_detail(
        self,
        files: Vec<String>,
        additions: u64,
        deletions: u64,
        commits: Vec<PrCommit>,
    ) -> PullRequestDetail {
        let changed_files = files.len() as u64;
        let body = self.body();
        let reviewers = self
            .reviewers
            .iter()
            .cloned()
            .map(BitbucketUser::into_author)
            .collect();
        PullRequestDetail {
            number: self.id,
            state: map_state(&self.state),
            mergeable: String::new(),
            head_ref: self.head_ref(),
            base_ref: self.base_ref(),
            author: self.author_or_default(),
            created_at: self.created_on.clone(),
            is_draft: self.draft,
            url: self.web_url(),
            additions,
            deletions,
            changed_files,
            body,
            comments: self.comment_count,
            files,
            // Discussion comments and inline review threads are out of scope for
            // GL-141, so the lists stay empty (the count above is informational).
            comment_list: Vec::new(),
            reviewers,
            // Bitbucket has no PR labels or milestones, and approval verdicts are
            // not mapped in v1.
            reviews: Vec::new(),
            assignees: Vec::new(),
            labels: Vec::new(),
            milestone: None,
            commits,
            title: self.title,
        }
    }
}

/// A Bitbucket commit reference (`author.user`) plus the plain-text `raw`
/// (`Name <email>`) used when Bitbucket cannot resolve a Bitbucket account.
#[derive(Debug, Clone, Deserialize)]
pub struct BitbucketCommitAuthor {
    #[serde(default)]
    pub raw: String,
    #[serde(default)]
    pub user: Option<BitbucketUser>,
}

/// One commit on a pull request (`/pullrequests/:id/commits`).
#[derive(Debug, Clone, Deserialize)]
pub struct BitbucketCommit {
    #[serde(default)]
    pub hash: String,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub author: Option<BitbucketCommitAuthor>,
}

impl BitbucketCommit {
    pub fn into_commit(self) -> PrCommit {
        let headline = self
            .message
            .as_deref()
            .and_then(|m| m.lines().next())
            .map(str::to_string)
            .unwrap_or_default();
        let (author_name, author_login) = match self.author {
            Some(a) => {
                let author = a.user.map(BitbucketUser::into_author);
                let name = author
                    .as_ref()
                    .map(|u| u.name.clone())
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| raw_author_name(&a.raw));
                let login = author.map(|u| u.login).unwrap_or_default();
                (name, login)
            }
            None => (String::new(), String::new()),
        };
        PrCommit {
            oid: self.hash,
            headline,
            authored_date: self.date.unwrap_or_default(),
            author_name,
            author_login,
            // Bitbucket's commit list carries no signature validity, so mirror the
            // unverified fast-path the GitHub provider uses before its GraphQL read.
            verified: false,
        }
    }
}

/// Extract the display name from a git-style `Name <email>` raw author string.
fn raw_author_name(raw: &str) -> String {
    raw.split('<').next().unwrap_or(raw).trim().to_string()
}

/// Map Bitbucket's PR `state` onto the raw value the frontend expects
/// (`OPEN` | `MERGED` | `CLOSED`). `DECLINED` and `SUPERSEDED` are both terminal
/// closed-without-merge states, folded into `CLOSED`.
pub fn map_state(state: &str) -> String {
    match state.to_ascii_uppercase().as_str() {
        "OPEN" => "OPEN",
        "MERGED" => "MERGED",
        "DECLINED" | "SUPERSEDED" => "CLOSED",
        other => return other.to_string(),
    }
    .to_string()
}

/// First of `candidates` that is `Some` and non-blank after trimming.
fn first_non_empty<const N: usize>(candidates: [Option<String>; N]) -> Option<String> {
    candidates
        .into_iter()
        .flatten()
        .find(|s| !s.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_state_to_raw_frontend_values() {
        assert_eq!(map_state("OPEN"), "OPEN");
        assert_eq!(map_state("MERGED"), "MERGED");
        assert_eq!(map_state("DECLINED"), "CLOSED");
        assert_eq!(map_state("SUPERSEDED"), "CLOSED");
    }

    #[test]
    fn parses_and_maps_a_pr_summary() {
        let json = r#"{
            "id": 7,
            "title": "Add feature",
            "state": "OPEN",
            "draft": false,
            "created_on": "2026-07-01T10:00:00Z",
            "source": {"branch": {"name": "feat"}},
            "destination": {"branch": {"name": "main"}},
            "author": {"display_name": "Ada L.", "nickname": "ada", "account_id": "1:2"},
            "links": {"html": {"href": "https://bitbucket.org/team/app/pull-requests/7"}}
        }"#;
        let pr: BitbucketPr = serde_json::from_str(json).expect("parse PR");
        let summary = pr.into_summary();
        assert_eq!(summary.number, 7);
        assert_eq!(summary.state, "OPEN");
        assert_eq!(summary.head_ref, "feat");
        assert_eq!(summary.base_ref, "main");
        assert_eq!(summary.author.login, "ada");
        assert_eq!(summary.author.name, "Ada L.");
        assert!(!summary.is_draft);
        assert_eq!(
            summary.url,
            "https://bitbucket.org/team/app/pull-requests/7"
        );
    }

    #[test]
    fn detail_reads_body_from_summary_and_maps_reviewers() {
        let json = r#"{
            "id": 9, "title": "T", "state": "OPEN",
            "source": {"branch": {"name": "s"}}, "destination": {"branch": {"name": "t"}},
            "author": {"nickname": "u"},
            "summary": {"raw": "Body text"},
            "reviewers": [{"nickname": "rev2", "display_name": "Rev Two"}],
            "comment_count": 3
        }"#;
        let pr: BitbucketPr = serde_json::from_str(json).unwrap();
        let detail = pr.into_detail(vec!["a.rs".into(), "b.rs".into()], 12, 4, Vec::new());
        assert_eq!(detail.body, "Body text");
        assert_eq!(detail.changed_files, 2);
        assert_eq!(detail.additions, 12);
        assert_eq!(detail.deletions, 4);
        assert_eq!(detail.reviewers[0].login, "rev2");
        assert_eq!(detail.reviewers[0].name, "Rev Two");
        assert_eq!(detail.comments, 3);
        assert!(detail.labels.is_empty());
    }

    #[test]
    fn detail_prefers_top_level_description_over_summary() {
        let json = r#"{
            "id": 1, "title": "T", "state": "OPEN",
            "description": "Raw desc", "summary": {"raw": "Rendered"},
            "author": {"nickname": "u"}
        }"#;
        let pr: BitbucketPr = serde_json::from_str(json).unwrap();
        assert_eq!(pr.into_detail(vec![], 0, 0, Vec::new()).body, "Raw desc");
    }

    #[test]
    fn maps_a_commit_with_and_without_a_resolved_user() {
        let with_user: BitbucketCommit = serde_json::from_str(
            r#"{"hash":"abc","message":"Fix bug\n\nbody","date":"2026-01-01",
                "author":{"raw":"Ada <a@x.io>","user":{"display_name":"Ada L.","nickname":"ada"}}}"#,
        )
        .unwrap();
        let c = with_user.into_commit();
        assert_eq!(c.oid, "abc");
        assert_eq!(c.headline, "Fix bug");
        assert_eq!(c.author_name, "Ada L.");
        assert_eq!(c.author_login, "ada");
        assert!(!c.verified);

        // No resolved Bitbucket account → fall back to the raw author name.
        let raw_only: BitbucketCommit = serde_json::from_str(
            r#"{"hash":"def","message":"Tidy","date":"2026-02-02","author":{"raw":"Bob <b@x.io>"}}"#,
        )
        .unwrap();
        let c2 = raw_only.into_commit();
        assert_eq!(c2.author_name, "Bob");
        assert_eq!(c2.author_login, "");
        assert_eq!(c2.authored_date, "2026-02-02");
    }
}
