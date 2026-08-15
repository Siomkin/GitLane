//! GitLab REST v4 response shapes and their mapping to the shared PR DTOs (GL-140).
//!
//! GitLab's merge-request JSON is reshaped into the same [`crate::git::types`]
//! `PullRequest*` types the GitHub provider emits, so the existing PR list/detail
//! UI renders GitLab MRs unchanged. Only the fields GitLab actually returns on the
//! MR endpoints are mapped; aggregate diff stats (additions/deletions/changed
//! files) are computed from the parsed `/diffs` payload by the caller, not carried
//! on the MR object. Every conversion here is pure and unit-tested — the transport
//! (glab CLI vs REST) is a separate concern.

use serde::Deserialize;

use crate::git::types::{
    Mergeable, PrAuthor, PrCommit, PrLabel, PrState, PullRequestDetail, PullRequestSummary,
};

/// A GitLab user reference (`author`, `assignees[]`, `reviewers[]`).
#[derive(Debug, Clone, Deserialize)]
pub struct GitlabUser {
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub name: Option<String>,
}

impl GitlabUser {
    pub fn into_author(self) -> PrAuthor {
        let login = self.username.trim().to_string();
        let name = self
            .name
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| login.clone());
        PrAuthor { login, name }
    }
}

/// GitLab labels come back either as bare name strings (default) or as objects
/// when the query asks for `with_labels_details=true`. Accept both so the caller
/// can pick either without a shape mismatch.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum GitlabLabel {
    Detailed {
        name: String,
        #[serde(default)]
        color: String,
    },
    Name(String),
}

impl GitlabLabel {
    pub fn into_label(self) -> PrLabel {
        match self {
            // `PrLabel.color` is a 6-hex RGB without the leading `#`; GitLab's
            // detailed color is `#RRGGBB`, so strip it.
            Self::Detailed { name, color } => PrLabel {
                name,
                color: color.trim().trim_start_matches('#').to_string(),
            },
            Self::Name(name) => PrLabel {
                name,
                color: String::new(),
            },
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct GitlabMilestone {
    #[serde(default)]
    pub title: String,
}

/// A GitLab merge request as returned by the list and single-MR endpoints. `iid`
/// (the per-project number) is used, never the global `id`.
#[derive(Debug, Clone, Deserialize)]
pub struct GitlabMr {
    pub iid: u64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub source_branch: String,
    #[serde(default)]
    pub target_branch: String,
    #[serde(default)]
    pub author: Option<GitlabUser>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub draft: bool,
    /// Legacy draft flag on older GitLab; folded into [`GitlabMr::is_draft`].
    #[serde(default)]
    pub work_in_progress: bool,
    #[serde(default)]
    pub web_url: String,
    #[serde(default)]
    pub merge_status: Option<String>,
    #[serde(default)]
    pub detailed_merge_status: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub labels: Vec<GitlabLabel>,
    #[serde(default)]
    pub assignees: Vec<GitlabUser>,
    #[serde(default)]
    pub reviewers: Vec<GitlabUser>,
    #[serde(default)]
    pub milestone: Option<GitlabMilestone>,
    #[serde(default)]
    pub user_notes_count: u64,
}

impl GitlabMr {
    fn author_or_default(&self) -> PrAuthor {
        self.author
            .clone()
            .map(GitlabUser::into_author)
            .unwrap_or_else(|| PrAuthor {
                login: String::new(),
                name: String::new(),
            })
    }

    pub fn is_draft(&self) -> bool {
        self.draft || self.work_in_progress
    }

    /// Map to the shared summary. The list endpoint carries no diff stats, so
    /// additions/deletions/changed files are zero here; the detail view fills
    /// them from the parsed `/diffs`.
    pub fn into_summary(self) -> PullRequestSummary {
        PullRequestSummary {
            number: self.iid,
            state: map_state(&self.state),
            mergeable: map_mergeable(
                self.detailed_merge_status.as_deref(),
                self.merge_status.as_deref(),
            ),
            head_ref: self.source_branch.clone(),
            base_ref: self.target_branch.clone(),
            author: self.author_or_default(),
            created_at: self.created_at.clone(),
            is_draft: self.is_draft(),
            url: self.web_url.clone(),
            additions: 0,
            deletions: 0,
            changed_files: 0,
            title: self.title,
        }
    }

    /// Map to the shared detail. `files`/`additions`/`deletions`/`changed_files`
    /// are computed by the caller from the parsed `/diffs`; `commits` is fetched
    /// separately (empty until the Commits tab loads it).
    pub fn into_detail(
        self,
        files: Vec<String>,
        additions: u64,
        deletions: u64,
        commits: Vec<PrCommit>,
    ) -> PullRequestDetail {
        let changed_files = files.len() as u64;
        PullRequestDetail {
            number: self.iid,
            state: map_state(&self.state),
            mergeable: map_mergeable(
                self.detailed_merge_status.as_deref(),
                self.merge_status.as_deref(),
            ),
            head_ref: self.source_branch.clone(),
            base_ref: self.target_branch.clone(),
            author: self.author_or_default(),
            created_at: self.created_at.clone(),
            is_draft: self.is_draft(),
            url: self.web_url.clone(),
            additions,
            deletions,
            changed_files,
            body: self.description.clone().unwrap_or_default(),
            comments: self.user_notes_count,
            files,
            // Discussion comments and inline review threads are out of scope for
            // GL-140, so the lists stay empty (the count above is informational).
            comment_list: Vec::new(),
            reviewers: self
                .reviewers
                .into_iter()
                .map(GitlabUser::into_author)
                .collect(),
            // Submitted-review verdicts (approvals) are not mapped in v1.
            reviews: Vec::new(),
            assignees: self
                .assignees
                .into_iter()
                .map(GitlabUser::into_author)
                .collect(),
            labels: self
                .labels
                .into_iter()
                .map(GitlabLabel::into_label)
                .collect(),
            milestone: self
                .milestone
                .map(|m| m.title)
                .filter(|s| !s.trim().is_empty()),
            commits,
            title: self.title,
        }
    }
}

/// One commit on a merge request (`/merge_requests/:iid/commits`).
#[derive(Debug, Clone, Deserialize)]
pub struct GitlabCommit {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub author_name: String,
    #[serde(default)]
    pub authored_date: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

impl GitlabCommit {
    pub fn into_commit(self) -> PrCommit {
        // Prefer the explicit title; fall back to the first line of the message.
        let headline = self
            .title
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                self.message
                    .as_deref()
                    .and_then(|m| m.lines().next())
                    .map(str::to_string)
            })
            .unwrap_or_default();
        PrCommit {
            oid: self.id,
            headline,
            authored_date: self.authored_date.or(self.created_at).unwrap_or_default(),
            author_name: self.author_name,
            // GitLab's commit list doesn't resolve the committer's GitLab login,
            // and signature validity isn't fetched here — mirror the unverified
            // fast-path the GitHub provider uses before the paginated read.
            author_login: String::new(),
            verified: false,
        }
    }
}

/// One changed file on a merge request (`/merge_requests/:iid/diffs`). The `diff`
/// field is the hunk body only (starting at `@@`), so [`super::ops`] reconstructs
/// a git patch header around it before parsing.
#[derive(Debug, Clone, Deserialize)]
pub struct GitlabDiff {
    #[serde(default)]
    pub old_path: String,
    #[serde(default)]
    pub new_path: String,
    #[serde(default)]
    pub new_file: bool,
    #[serde(default)]
    pub renamed_file: bool,
    #[serde(default)]
    pub deleted_file: bool,
    #[serde(default)]
    pub diff: String,
}

/// Map GitLab's MR `state` onto the shared [`PrState`]. GitLab's `locked` is a
/// transient closed-ish state, folded into `Closed`; unknown states pass
/// through uppercased, as GitLane's passthrough contract requires.
pub fn map_state(state: &str) -> PrState {
    match state {
        "opened" => PrState::Open,
        "merged" => PrState::Merged,
        "closed" | "locked" => PrState::Closed,
        other => PrState::Other(other.to_ascii_uppercase()),
    }
}

/// Map GitLab mergeability onto the shared [`Mergeable`] verdict set. Prefer
/// `detailed_merge_status` (GitLab 15.6+); fall back to the legacy
/// `merge_status`. Unknown detailed statuses collapse to `Unknown` — that is
/// GitLane's own "not decided yet", matching gh's behaviour while GitHub
/// computes.
pub fn map_mergeable(detailed: Option<&str>, legacy: Option<&str>) -> Mergeable {
    if let Some(detailed) = detailed.map(str::trim).filter(|s| !s.is_empty()) {
        return match detailed {
            "mergeable" => Mergeable::Yes,
            "conflict" | "broken_status" => Mergeable::Conflicting,
            _ => Mergeable::Unknown,
        };
    }
    match legacy.map(str::trim).filter(|s| !s.is_empty()) {
        Some("can_be_merged") => Mergeable::Yes,
        Some("cannot_be_merged") | Some("cannot_be_merged_recheck") => Mergeable::Conflicting,
        Some(_) => Mergeable::Unknown,
        None => Mergeable::Unset,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::types::{Mergeable, PrState};

    #[test]
    fn maps_state_to_raw_frontend_values() {
        assert_eq!(map_state("opened"), PrState::Open);
        assert_eq!(map_state("merged"), PrState::Merged);
        assert_eq!(map_state("closed"), PrState::Closed);
        assert_eq!(map_state("locked"), PrState::Closed);
    }

    #[test]
    fn maps_mergeability_preferring_detailed_status() {
        assert_eq!(
            map_mergeable(Some("mergeable"), Some("cannot_be_merged")),
            Mergeable::Yes
        );
        assert_eq!(
            map_mergeable(Some("conflict"), None),
            Mergeable::Conflicting
        );
        assert_eq!(
            map_mergeable(Some("ci_still_running"), None),
            Mergeable::Unknown
        );
        // Falls back to the legacy field when detailed is absent/empty.
        assert_eq!(
            map_mergeable(None, Some("can_be_merged")),
            Mergeable::Yes
        );
        assert_eq!(
            map_mergeable(Some(""), Some("cannot_be_merged")),
            Mergeable::Conflicting
        );
        assert_eq!(map_mergeable(None, None), Mergeable::Unset);
    }

    #[test]
    fn parses_and_maps_an_mr_summary() {
        let json = r##"{
            "iid": 7,
            "title": "Add feature",
            "state": "opened",
            "source_branch": "feat",
            "target_branch": "main",
            "author": {"username": "ada", "name": "Ada L."},
            "created_at": "2026-07-01T10:00:00Z",
            "draft": false,
            "web_url": "https://gitlab.com/group/repo/-/merge_requests/7",
            "detailed_merge_status": "mergeable",
            "labels": [{"name": "bug", "color": "#ff0000"}, "chore"]
        }"##;
        let mr: GitlabMr = serde_json::from_str(json).expect("parse MR");
        let summary = mr.into_summary();
        assert_eq!(summary.number, 7);
        assert_eq!(summary.state, PrState::Open);
        assert_eq!(summary.head_ref, "feat");
        assert_eq!(summary.base_ref, "main");
        assert_eq!(summary.author.login, "ada");
        assert_eq!(summary.author.name, "Ada L.");
        assert_eq!(summary.mergeable, Mergeable::Yes);
        assert!(!summary.is_draft);
        assert_eq!(
            summary.url,
            "https://gitlab.com/group/repo/-/merge_requests/7"
        );
    }

    #[test]
    fn work_in_progress_counts_as_draft() {
        let json = r#"{"iid":1,"title":"WIP","state":"opened","source_branch":"a",
            "target_branch":"b","author":{"username":"x"},"created_at":"t","work_in_progress":true}"#;
        let mr: GitlabMr = serde_json::from_str(json).unwrap();
        assert!(mr.is_draft());
        assert!(mr.into_summary().is_draft);
    }

    #[test]
    fn detail_carries_labels_assignees_and_computed_stats() {
        let json = r##"{
            "iid": 9, "title": "T", "state": "opened", "source_branch": "s",
            "target_branch": "t", "author": {"username": "u"}, "created_at": "c",
            "description": "Body text",
            "labels": [{"name": "bug", "color": "#abcdef"}],
            "assignees": [{"username": "rev1"}],
            "reviewers": [{"username": "rev2", "name": "Rev Two"}],
            "milestone": {"title": "v1"},
            "user_notes_count": 3
        }"##;
        let mr: GitlabMr = serde_json::from_str(json).unwrap();
        let detail = mr.into_detail(vec!["a.rs".into(), "b.rs".into()], 12, 4, Vec::new());
        assert_eq!(detail.body, "Body text");
        assert_eq!(detail.changed_files, 2);
        assert_eq!(detail.additions, 12);
        assert_eq!(detail.deletions, 4);
        assert_eq!(detail.labels.len(), 1);
        assert_eq!(detail.labels[0].name, "bug");
        assert_eq!(detail.labels[0].color, "abcdef", "leading # is stripped");
        assert_eq!(detail.assignees[0].login, "rev1");
        assert_eq!(detail.reviewers[0].name, "Rev Two");
        assert_eq!(detail.milestone.as_deref(), Some("v1"));
        assert_eq!(detail.comments, 3);
    }

    #[test]
    fn maps_a_commit_falling_back_to_message_headline() {
        let with_title: GitlabCommit = serde_json::from_str(
            r#"{"id":"abc","title":"Fix bug","author_name":"Ada","authored_date":"2026-01-01"}"#,
        )
        .unwrap();
        let c = with_title.into_commit();
        assert_eq!(c.oid, "abc");
        assert_eq!(c.headline, "Fix bug");
        assert_eq!(c.author_name, "Ada");
        assert!(!c.verified);

        let from_message: GitlabCommit = serde_json::from_str(
            r#"{"id":"def","message":"Headline\n\nbody","author_name":"B","created_at":"2026-02-02"}"#,
        )
        .unwrap();
        let c2 = from_message.into_commit();
        assert_eq!(c2.headline, "Headline");
        assert_eq!(c2.authored_date, "2026-02-02");
    }
}
