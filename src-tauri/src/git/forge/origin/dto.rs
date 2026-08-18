use serde::Deserialize;

use super::super::domain::GithubError;
use super::super::ForgeKind;
use crate::git::types::{
    Mergeable, PrAuthor, PrComment, PrCommit, PrState, PullRequestDetail, PullRequestSummary,
    ReviewThread,
};

pub(super) fn parse_pr_number(raw: &str) -> Result<u64, GithubError> {
    let trimmed = raw.trim();
    trimmed.parse::<u64>().map_err(|_| {
        GithubError::InvalidResponse(format!("Invalid Origin pull request number: {raw}"))
    })
}

fn deserialize_pr_number<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<u64, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Num {
        N(u64),
        S(String),
    }
    match Num::deserialize(deserializer)? {
        Num::N(n) => Ok(n),
        Num::S(s) => {
            parse_pr_number(&s).map_err(|err| serde::de::Error::custom(err.to_ipc_string()))
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OriginActor {
    #[serde(default)]
    user: Option<OriginUser>,
    #[serde(default)]
    email: String,
    #[serde(default)]
    login: String,
    #[serde(default)]
    id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OriginUser {
    #[serde(default)]
    id: String,
    #[serde(default)]
    email: String,
}

impl OriginActor {
    fn into_author(self) -> PrAuthor {
        let nested = self.user.as_ref().and_then(|u| {
            if !u.email.is_empty() {
                Some(u.email.clone())
            } else if !u.id.is_empty() {
                Some(u.id.clone())
            } else {
                None
            }
        });
        let login = nested
            .or_else(|| (!self.email.is_empty()).then(|| self.email.clone()))
            .or_else(|| (!self.login.is_empty()).then(|| self.login.clone()))
            .or_else(|| (!self.id.is_empty()).then(|| self.id.clone()))
            .unwrap_or_default();
        PrAuthor {
            name: login.clone(),
            login,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OriginRef {
    #[serde(default)]
    r#ref: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OriginPull {
    #[serde(deserialize_with = "deserialize_pr_number")]
    number: u64,
    #[serde(default)]
    title: String,
    #[serde(default, alias = "status")]
    state: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    merged: bool,
    #[serde(default)]
    body: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    author: Option<OriginActor>,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    additions: u64,
    #[serde(default)]
    deletions: u64,
    #[serde(default)]
    changed_files: u64,
    #[serde(default)]
    head: Option<OriginRef>,
    #[serde(default)]
    base: Option<OriginRef>,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    url: String,
}

impl OriginPull {
    fn state(&self) -> PrState {
        if self.merged || self.state.eq_ignore_ascii_case("merged") {
            PrState::Merged
        } else if self.state.eq_ignore_ascii_case("closed") {
            PrState::Closed
        } else {
            PrState::Open
        }
    }

    fn web_url(&self, owner: &str, name: &str) -> String {
        if !self.html_url.is_empty() {
            return self.html_url.clone();
        }
        if !self.url.is_empty() && self.url.starts_with("http") {
            return self.url.clone();
        }
        format!(
            "{}/{owner}/{name}/pull/{}",
            ForgeKind::CURSOR_ORIGIN_WEB_ROOT,
            self.number
        )
    }

    fn author(&self) -> PrAuthor {
        self.author
            .clone()
            .map(OriginActor::into_author)
            .unwrap_or(PrAuthor {
                login: String::new(),
                name: String::new(),
            })
    }

    pub(super) fn into_summary(self, owner: &str, name: &str) -> PullRequestSummary {
        PullRequestSummary {
            number: self.number,
            title: self.title.clone(),
            state: self.state(),
            head_ref: self
                .head
                .as_ref()
                .map(|h| h.r#ref.clone())
                .unwrap_or_default(),
            base_ref: self
                .base
                .as_ref()
                .map(|b| b.r#ref.clone())
                .unwrap_or_default(),
            author: self.author(),
            created_at: self.created_at.clone(),
            additions: self.additions,
            deletions: self.deletions,
            changed_files: self.changed_files,
            is_draft: self.draft,
            url: self.web_url(owner, name),
            mergeable: Mergeable::Unset,
        }
    }

    pub(super) fn into_detail(
        self,
        owner: &str,
        name: &str,
        files: Vec<String>,
        comments: Vec<PrComment>,
    ) -> PullRequestDetail {
        let body = if self.body.is_empty() {
            self.description.clone()
        } else {
            self.body.clone()
        };
        PullRequestDetail {
            number: self.number,
            title: self.title.clone(),
            state: self.state(),
            head_ref: self
                .head
                .as_ref()
                .map(|h| h.r#ref.clone())
                .unwrap_or_default(),
            base_ref: self
                .base
                .as_ref()
                .map(|b| b.r#ref.clone())
                .unwrap_or_default(),
            author: self.author(),
            created_at: self.created_at.clone(),
            additions: self.additions,
            deletions: self.deletions,
            changed_files: self.changed_files.max(files.len() as u64),
            is_draft: self.draft,
            url: self.web_url(owner, name),
            body,
            comments: comments.len() as u64,
            files,
            comment_list: comments,
            mergeable: Mergeable::Unset,
            reviewers: Vec::new(),
            reviews: Vec::new(),
            assignees: Vec::new(),
            labels: Vec::new(),
            milestone: None,
            commits: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct OriginPullList {
    /// Origin's REST list is `{ "pullRequests": [...] }`; keep `pulls` for a
    /// GitHub-shaped payload so a missing alias cannot silently yield [].
    #[serde(default, alias = "pullRequests")]
    pub(super) pulls: Vec<OriginPull>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum OriginCommentAuthor {
    Actor(OriginActor),
    Login(String),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OriginComment {
    #[serde(default, alias = "description", alias = "text")]
    body: String,
    #[serde(default)]
    author: Option<OriginCommentAuthor>,
    #[serde(default)]
    created_at: String,
}

impl OriginComment {
    pub(super) fn into_comment(self) -> PrComment {
        let author = match self.author {
            Some(OriginCommentAuthor::Actor(actor)) => actor.into_author(),
            Some(OriginCommentAuthor::Login(login)) => PrAuthor {
                name: login.clone(),
                login,
            },
            None => PrAuthor {
                login: String::new(),
                name: String::new(),
            },
        };
        PrComment {
            author,
            body: self.body,
            created_at: self.created_at,
        }
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct OriginCommentList {
    /// `origin pr view --json comments` is `{ "comments": [...] }`. No default:
    /// a REST wrapper like `{ "pullRequest": ... }` must fail to parse instead
    /// of silently yielding [].
    #[serde(alias = "discussionComments")]
    pub(super) comments: Vec<OriginComment>,
}

#[derive(Debug, Deserialize)]
pub(super) struct OriginCommit {
    #[serde(default)]
    sha: String,
    #[serde(default)]
    commit: Option<OriginCommitBody>,
}

#[derive(Debug, Deserialize)]
struct OriginCommitBody {
    #[serde(default)]
    message: String,
    #[serde(default)]
    author: Option<OriginCommitAuthor>,
}

#[derive(Debug, Deserialize)]
struct OriginCommitAuthor {
    #[serde(default)]
    name: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    date: String,
}

impl OriginCommit {
    pub(super) fn into_commit(self) -> PrCommit {
        let body = self.commit.unwrap_or(OriginCommitBody {
            message: String::new(),
            author: None,
        });
        let headline = body.message.lines().next().unwrap_or("").to_string();
        let author = body.author.unwrap_or(OriginCommitAuthor {
            name: String::new(),
            email: String::new(),
            date: String::new(),
        });
        PrCommit {
            oid: self.sha,
            headline,
            authored_date: author.date,
            author_name: author.name,
            author_login: author.email,
            verified: false,
        }
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct OriginCommitList {
    /// Origin's REST commits endpoint is `{ "commits": [...] }`. No default:
    /// a missing field must fail so we don't silently yield [].
    #[serde(alias = "commitList")]
    pub(super) commits: Vec<OriginCommit>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OriginThread {
    #[serde(default)]
    id: String,
    #[serde(default)]
    resolved: bool,
    #[serde(default)]
    path: String,
    #[serde(default)]
    line: Option<u32>,
    #[serde(default)]
    comments: Vec<OriginComment>,
}

impl OriginThread {
    pub(super) fn into_thread(self) -> ReviewThread {
        ReviewThread {
            id: self.id,
            path: self.path,
            line: self.line,
            is_resolved: self.resolved,
            is_outdated: false,
            comments_truncated: false,
            comments: self
                .comments
                .into_iter()
                .map(OriginComment::into_comment)
                .collect(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct OriginThreadList {
    #[serde(default)]
    pub(super) threads: Vec<OriginThread>,
}

pub(super) fn parse_json<T: for<'de> Deserialize<'de>>(
    raw: &str,
    what: &str,
) -> Result<T, GithubError> {
    serde_json::from_str(raw).map_err(|err| {
        GithubError::InvalidResponse(format!("Could not parse Origin {what}: {err}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_string_and_numeric_pr_numbers() {
        assert_eq!(parse_pr_number("13").unwrap(), 13);
        assert!(parse_pr_number("nope").is_err());
        assert!(parse_pr_number("18446744073709551616").is_err());
        let pull: OriginPull =
            serde_json::from_str(r#"{"number":"7","title":"Fix","state":"open"}"#).unwrap();
        assert_eq!(pull.number, 7);
        let pull: OriginPull =
            serde_json::from_str(r#"{"number":8,"title":"Fix","state":"open"}"#).unwrap();
        assert_eq!(pull.number, 8);
    }

    #[test]
    fn maps_merged_closed_and_draft() {
        let merged: OriginPull = serde_json::from_str(
            r#"{"number":"1","title":"t","state":"closed","merged":true,"draft":true}"#,
        )
        .unwrap();
        let summary = merged.into_summary("acme", "app");
        assert_eq!(summary.state, PrState::Merged);
        assert!(summary.is_draft);
        assert_eq!(
            summary.url,
            format!("{}/acme/app/pull/1", ForgeKind::CURSOR_ORIGIN_WEB_ROOT)
        );
    }

    #[test]
    fn parses_origin_api_merged_list_item() {
        // Origin's REST list item for a merged PR: `state` is "closed" and
        // `merged` is true (no `status` field). Closed/All must see Merged.
        let list: OriginPullList = serde_json::from_str(
            r#"{"pullRequests":[{"number":"1","title":"t","state":"closed","merged":true}]}"#,
        )
        .unwrap();
        let summary = list
            .pulls
            .into_iter()
            .next()
            .unwrap()
            .into_summary("acme", "app");
        assert_eq!(summary.state, PrState::Merged);
        assert_eq!(summary.number, 1);
    }

    #[test]
    fn parses_origin_list_wrapper_pull_requests() {
        let list: OriginPullList = serde_json::from_str(
            r#"{"pullRequests":[{"number":"1","title":"Fix","state":"open"}]}"#,
        )
        .unwrap();
        assert_eq!(list.pulls.len(), 1);
        assert_eq!(list.pulls[0].number, 1);
        assert_eq!(list.pulls[0].title, "Fix");
    }

    #[test]
    fn parses_view_json_comments_and_rejects_rest_wrapper() {
        let list: OriginCommentList = serde_json::from_str(
            r#"{"comments":[{"body":"Looks good","author":{"login":"ada"},"createdAt":"t"}]}"#,
        )
        .unwrap();
        assert_eq!(list.comments.len(), 1);
        let comment = list.comments.into_iter().next().unwrap().into_comment();
        assert_eq!(comment.body, "Looks good");
        assert_eq!(comment.author.login, "ada");
        assert!(
            serde_json::from_str::<OriginCommentList>(r#"{"pullRequest":{"number":1}}"#).is_err()
        );
    }

    #[test]
    fn parses_commits_wrapper_and_rejects_unrelated_object() {
        let list: OriginCommitList = serde_json::from_str(
            r#"{"commits":[{"sha":"abc","commit":{"message":"hi","author":{"name":"Ada"}}}]}"#,
        )
        .unwrap();
        assert_eq!(list.commits.len(), 1);
        assert_eq!(
            list.commits
                .into_iter()
                .next()
                .unwrap()
                .into_commit()
                .headline,
            "hi"
        );
        assert!(
            serde_json::from_str::<OriginCommitList>(r#"{"pullRequest":{"number":1}}"#).is_err()
        );
    }
}
