//! `gh pr list` / `gh pr view` projection shapes and their conversions.

use serde::Deserialize;

use crate::git::types::{CheckState, PrAuthor, PrComment, PrCommit};

#[derive(Deserialize, Default)]
pub(in crate::git::forge) struct GhAuthor {
    #[serde(default)]
    pub(in crate::git::forge) login: String,
    #[serde(default)]
    pub(in crate::git::forge) name: Option<String>,
}

impl GhAuthor {
    pub(in crate::git::forge) fn into_author(self) -> PrAuthor {
        PrAuthor {
            login: self.login,
            name: self.name.unwrap_or_default(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GhPrSummary {
    pub(in crate::git::forge) number: u64,
    pub(in crate::git::forge) title: String,
    pub(in crate::git::forge) state: String,
    pub(in crate::git::forge) head_ref_name: String,
    pub(in crate::git::forge) base_ref_name: String,
    pub(in crate::git::forge) author: GhAuthor,
    pub(in crate::git::forge) created_at: String,
    pub(in crate::git::forge) additions: u64,
    pub(in crate::git::forge) deletions: u64,
    pub(in crate::git::forge) changed_files: u64,
    pub(in crate::git::forge) is_draft: bool,
    pub(in crate::git::forge) url: String,
    #[serde(default)]
    pub(in crate::git::forge) mergeable: String,
}

#[derive(Deserialize)]
pub(in crate::git::forge) struct GhFile {
    pub(in crate::git::forge) path: String,
}

/// Author shape inside the `comments` projection — only `login` is populated.
#[derive(Deserialize, Default)]
pub(in crate::git::forge) struct GhCommentAuthor {
    #[serde(default)]
    pub(in crate::git::forge) login: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GhComment {
    #[serde(default)]
    pub(in crate::git::forge) author: GhCommentAuthor,
    #[serde(default)]
    pub(in crate::git::forge) body: String,
    #[serde(default)]
    pub(in crate::git::forge) created_at: String,
}

impl GhComment {
    pub(in crate::git::forge) fn into_comment(self) -> PrComment {
        let login = self.author.login;
        PrComment {
            author: PrAuthor {
                name: login.clone(),
                login,
            },
            body: self.body,
            created_at: self.created_at,
        }
    }
}

/// A requested reviewer — a `User` (login) or a `Team` (name/slug). gh tags the
/// union with `__typename`; we just want a display handle.
#[derive(Deserialize)]
pub(in crate::git::forge) struct GhReviewer {
    #[serde(default)]
    pub(in crate::git::forge) login: String,
    #[serde(default)]
    pub(in crate::git::forge) name: Option<String>,
    #[serde(default)]
    pub(in crate::git::forge) slug: Option<String>,
}

impl GhReviewer {
    pub(in crate::git::forge) fn into_author(self) -> PrAuthor {
        let handle = if !self.login.is_empty() {
            self.login
        } else {
            self.name.or(self.slug).unwrap_or_default()
        };
        PrAuthor {
            name: handle.clone(),
            login: handle,
        }
    }
}

#[derive(Deserialize)]
pub(in crate::git::forge) struct GhLabel {
    #[serde(default)]
    pub(in crate::git::forge) name: String,
    #[serde(default)]
    pub(in crate::git::forge) color: String,
}

#[derive(Deserialize)]
pub(in crate::git::forge) struct GhMilestone {
    #[serde(default)]
    pub(in crate::git::forge) title: String,
}

/// One author entry inside a commit's `authors` array. GitHub can return an
/// empty array (no resolvable author), which we map to a missing-author commit.
#[derive(Deserialize, Default)]
pub(in crate::git::forge) struct GhCommitAuthor {
    #[serde(default)]
    pub(in crate::git::forge) login: String,
    #[serde(default)]
    pub(in crate::git::forge) name: String,
}

/// A commit in the `commits` projection of `gh pr view`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GhCommit {
    pub(in crate::git::forge) oid: String,
    #[serde(default)]
    pub(in crate::git::forge) message_headline: String,
    #[serde(default)]
    pub(in crate::git::forge) authored_date: String,
    #[serde(default)]
    pub(in crate::git::forge) authors: Vec<GhCommitAuthor>,
}

impl GhCommit {
    pub(in crate::git::forge) fn into_commit(self) -> PrCommit {
        // GitHub may list several authors (co-authored) or none; show the first,
        // preferring display name over login, and leave both empty when absent.
        let (author_name, author_login) = match self.authors.into_iter().next() {
            Some(a) => {
                let name = if a.name.is_empty() {
                    a.login.clone()
                } else {
                    a.name
                };
                (name, a.login)
            }
            None => (String::new(), String::new()),
        };
        PrCommit {
            oid: self.oid,
            headline: self.message_headline,
            authored_date: self.authored_date,
            author_name,
            author_login,
            // `gh pr view` carries no signature data; the paginated GraphQL
            // commit read fills real verification in when the Commits tab opens.
            verified: false,
        }
    }
}

#[derive(Deserialize)]
pub(in crate::git::forge) struct GhReview {
    #[serde(default)]
    pub(in crate::git::forge) author: GhAuthor,
    #[serde(default)]
    pub(in crate::git::forge) state: String,
}

#[derive(Deserialize)]
pub(in crate::git::forge) struct GhCheck {
    #[serde(default)]
    pub(in crate::git::forge) name: Option<String>,
    #[serde(default)]
    pub(in crate::git::forge) context: Option<String>,
    #[serde(default)]
    pub(in crate::git::forge) conclusion: Option<String>,
    #[serde(default)]
    pub(in crate::git::forge) state: Option<String>,
}

impl GhCheck {
    pub(in crate::git::forge) fn name(&self) -> String {
        self.name
            .clone()
            .or_else(|| self.context.clone())
            .unwrap_or_else(|| "check".to_string())
    }

    /// Display check result. A SUCCESS conclusion (or SUCCESS state) passes;
    /// NEUTRAL/SKIPPED stay distinct; a present non-success conclusion (or
    /// FAILURE/ERROR state) fails; anything still in flight (no conclusion and
    /// a pending/absent state) is pending rather than collapsed into a failure.
    pub(in crate::git::forge) fn status(&self) -> CheckState {
        if let Some(c) = &self.conclusion {
            return match c.as_str() {
                "SUCCESS" => CheckState::Pass,
                "NEUTRAL" | "SKIPPED" => CheckState::Skipped,
                "" => CheckState::Pending,
                _ => CheckState::Fail,
            };
        }
        match self.state.as_deref() {
            Some("SUCCESS") => CheckState::Pass,
            Some("FAILURE") | Some("ERROR") => CheckState::Fail,
            _ => CheckState::Pending,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GhPrDetail {
    pub(in crate::git::forge) number: u64,
    pub(in crate::git::forge) title: String,
    pub(in crate::git::forge) state: String,
    pub(in crate::git::forge) head_ref_name: String,
    pub(in crate::git::forge) base_ref_name: String,
    pub(in crate::git::forge) author: GhAuthor,
    pub(in crate::git::forge) created_at: String,
    pub(in crate::git::forge) additions: u64,
    pub(in crate::git::forge) deletions: u64,
    pub(in crate::git::forge) changed_files: u64,
    pub(in crate::git::forge) is_draft: bool,
    pub(in crate::git::forge) url: String,
    #[serde(default)]
    pub(in crate::git::forge) body: String,
    #[serde(default)]
    pub(in crate::git::forge) comments: Vec<GhComment>,
    #[serde(default)]
    pub(in crate::git::forge) files: Vec<GhFile>,
    #[serde(default)]
    pub(in crate::git::forge) mergeable: String,
    #[serde(default)]
    pub(in crate::git::forge) review_requests: Vec<GhReviewer>,
    #[serde(default)]
    pub(in crate::git::forge) reviews: Vec<GhReview>,
    #[serde(default)]
    pub(in crate::git::forge) assignees: Vec<GhAuthor>,
    #[serde(default)]
    pub(in crate::git::forge) labels: Vec<GhLabel>,
    #[serde(default)]
    pub(in crate::git::forge) milestone: Option<GhMilestone>,
    #[serde(default)]
    pub(in crate::git::forge) commits: Vec<GhCommit>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GhChecksOnly {
    #[serde(default)]
    pub(in crate::git::forge) status_check_rollup: Vec<GhCheck>,
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- check-state normalization (GhCheck::ok / name) ----

    fn gh_check(
        name: Option<&str>,
        context: Option<&str>,
        conclusion: Option<&str>,
        state: Option<&str>,
    ) -> GhCheck {
        GhCheck {
            name: name.map(str::to_string),
            context: context.map(str::to_string),
            conclusion: conclusion.map(str::to_string),
            state: state.map(str::to_string),
        }
    }

    #[test]
    fn check_passes_on_success_conclusion() {
        assert_eq!(
            gh_check(None, None, Some("SUCCESS"), None).status(),
            CheckState::Pass
        );
    }

    #[test]
    fn check_keeps_neutral_or_skipped_conclusion_distinct() {
        assert_eq!(
            gh_check(None, None, Some("NEUTRAL"), None).status(),
            CheckState::Skipped
        );
        assert_eq!(
            gh_check(None, None, Some("SKIPPED"), None).status(),
            CheckState::Skipped
        );
    }

    #[test]
    fn check_fails_on_failure_conclusion() {
        assert_eq!(
            gh_check(None, None, Some("FAILURE"), None).status(),
            CheckState::Fail
        );
        assert_eq!(
            gh_check(None, None, Some("TIMED_OUT"), None).status(),
            CheckState::Fail
        );
        // A failing conclusion wins even when the state field looks healthy.
        assert_eq!(
            gh_check(None, None, Some("FAILURE"), Some("SUCCESS")).status(),
            CheckState::Fail
        );
    }

    #[test]
    fn check_falls_back_to_state_when_no_conclusion() {
        assert_eq!(
            gh_check(None, None, None, Some("SUCCESS")).status(),
            CheckState::Pass
        );
        // In-flight checks are pending, NOT collapsed into a failure.
        assert_eq!(
            gh_check(None, None, None, Some("PENDING")).status(),
            CheckState::Pending
        );
        assert_eq!(
            gh_check(None, None, None, None).status(),
            CheckState::Pending
        );
    }

    #[test]
    fn check_name_prefers_name_then_context_then_default() {
        assert_eq!(gh_check(Some("CI"), Some("ctx"), None, None).name(), "CI");
        assert_eq!(gh_check(None, Some("ctx"), None, None).name(), "ctx");
        assert_eq!(gh_check(None, None, None, None).name(), "check");
    }

    // ---- reviewer / team conversion (GhReviewer::into_author) ----

    #[test]
    fn reviewer_with_login_uses_login() {
        let a = GhReviewer {
            login: "octocat".into(),
            name: None,
            slug: None,
        }
        .into_author();
        assert_eq!(a.login, "octocat");
        assert_eq!(a.name, "octocat");
    }

    #[test]
    fn team_reviewer_falls_back_to_name_then_slug() {
        // No login → a Team: prefer `name`, then `slug`.
        let by_name = GhReviewer {
            login: String::new(),
            name: Some("Eng Team".into()),
            slug: Some("eng".into()),
        }
        .into_author();
        assert_eq!(by_name.login, "Eng Team");
        assert_eq!(by_name.name, "Eng Team");

        let by_slug = GhReviewer {
            login: String::new(),
            name: None,
            slug: Some("eng".into()),
        }
        .into_author();
        assert_eq!(by_slug.login, "eng");

        let empty = GhReviewer {
            login: String::new(),
            name: None,
            slug: None,
        }
        .into_author();
        assert_eq!(empty.login, "");
        assert_eq!(empty.name, "");
    }

    // ---- commit mapping (GhCommit::into_commit) ----

    #[test]
    fn commit_maps_first_author_preferring_name() {
        let c: GhCommit = serde_json::from_str(
            r#"{"oid":"abc123def456","messageHeadline":"feat: thing",
                "authoredDate":"2026-06-22T07:01:01Z",
                "authors":[{"login":"octocat","name":"Octo Cat"}]}"#,
        )
        .unwrap();
        let m = c.into_commit();
        assert_eq!(m.oid, "abc123def456");
        assert_eq!(m.headline, "feat: thing");
        assert_eq!(m.authored_date, "2026-06-22T07:01:01Z");
        assert_eq!(m.author_name, "Octo Cat");
        assert_eq!(m.author_login, "octocat");
    }

    #[test]
    fn commit_author_name_falls_back_to_login() {
        let c: GhCommit =
            serde_json::from_str(r#"{"oid":"a","authors":[{"login":"octocat","name":""}]}"#)
                .unwrap();
        let m = c.into_commit();
        assert_eq!(m.author_name, "octocat");
        assert_eq!(m.author_login, "octocat");
    }

    #[test]
    fn commit_with_no_authors_renders_empty_author() {
        // Missing `authors` (and an empty array) must not break mapping.
        let missing: GhCommit =
            serde_json::from_str(r#"{"oid":"a","messageHeadline":"x"}"#).unwrap();
        let m = missing.into_commit();
        assert_eq!(m.author_name, "");
        assert_eq!(m.author_login, "");

        let empty: GhCommit = serde_json::from_str(r#"{"oid":"a","authors":[]}"#).unwrap();
        assert_eq!(empty.into_commit().author_name, "");
    }

    #[test]
    fn commit_takes_first_of_multiple_authors() {
        let c: GhCommit = serde_json::from_str(
            r#"{"oid":"a","authors":[{"login":"first","name":"First"},{"login":"second","name":"Second"}]}"#,
        )
        .unwrap();
        assert_eq!(c.into_commit().author_login, "first");
    }
}
