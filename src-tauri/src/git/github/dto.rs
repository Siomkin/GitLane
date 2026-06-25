//! Private `gh` / GraphQL response shapes and their conversions into the public
//! [`crate::git::types`] domain types.
//!
//! Everything here is `pub(super)` — visible only within the `github` module
//! tree — so raw transport JSON never leaks through the [`super`] facade. This
//! module never invokes `gh`; it only deserializes and maps. `GhUser` is shared
//! with [`super::cli`] for authenticated-user lookup during account discovery.

use serde::Deserialize;

use crate::git::types::{PrAuthor, PrComment, PrCommit, PrCommitSignature, ReviewThread};

#[derive(Deserialize)]
pub(super) struct GhUser {
    pub(super) login: String,
    #[serde(default)]
    pub(super) name: Option<String>,
    #[serde(default)]
    pub(super) email: Option<String>,
    pub(super) id: u64,
}

#[derive(Deserialize, Default)]
pub(super) struct GhAuthor {
    #[serde(default)]
    pub(super) login: String,
    #[serde(default)]
    pub(super) name: Option<String>,
}

impl GhAuthor {
    pub(super) fn into_author(self) -> PrAuthor {
        PrAuthor {
            login: self.login,
            name: self.name.unwrap_or_default(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GhPrSummary {
    pub(super) number: u64,
    pub(super) title: String,
    pub(super) state: String,
    pub(super) head_ref_name: String,
    pub(super) base_ref_name: String,
    pub(super) author: GhAuthor,
    pub(super) created_at: String,
    pub(super) additions: u64,
    pub(super) deletions: u64,
    pub(super) changed_files: u64,
    pub(super) is_draft: bool,
    pub(super) url: String,
    #[serde(default)]
    pub(super) mergeable: String,
}

#[derive(Deserialize)]
pub(super) struct GhFile {
    pub(super) path: String,
}

/// Author shape inside the `comments` projection — only `login` is populated.
#[derive(Deserialize, Default)]
pub(super) struct GhCommentAuthor {
    #[serde(default)]
    pub(super) login: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GhComment {
    #[serde(default)]
    pub(super) author: GhCommentAuthor,
    #[serde(default)]
    pub(super) body: String,
    #[serde(default)]
    pub(super) created_at: String,
}

impl GhComment {
    pub(super) fn into_comment(self) -> PrComment {
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
pub(super) struct GhReviewer {
    #[serde(default)]
    pub(super) login: String,
    #[serde(default)]
    pub(super) name: Option<String>,
    #[serde(default)]
    pub(super) slug: Option<String>,
}

impl GhReviewer {
    pub(super) fn into_author(self) -> PrAuthor {
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
pub(super) struct GhLabel {
    #[serde(default)]
    pub(super) name: String,
    #[serde(default)]
    pub(super) color: String,
}

#[derive(Deserialize)]
pub(super) struct GhMilestone {
    #[serde(default)]
    pub(super) title: String,
}

/// One author entry inside a commit's `authors` array. GitHub can return an
/// empty array (no resolvable author), which we map to a missing-author commit.
#[derive(Deserialize, Default)]
pub(super) struct GhCommitAuthor {
    #[serde(default)]
    pub(super) login: String,
    #[serde(default)]
    pub(super) name: String,
}

/// A commit in the `commits` projection of `gh pr view`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GhCommit {
    pub(super) oid: String,
    #[serde(default)]
    pub(super) message_headline: String,
    #[serde(default)]
    pub(super) authored_date: String,
    #[serde(default)]
    pub(super) authors: Vec<GhCommitAuthor>,
}

impl GhCommit {
    pub(super) fn into_commit(self) -> PrCommit {
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
        }
    }
}

#[derive(Deserialize)]
pub(super) struct GhReview {
    #[serde(default)]
    pub(super) author: GhAuthor,
    #[serde(default)]
    pub(super) state: String,
}

#[derive(Deserialize)]
pub(super) struct GhCheck {
    #[serde(default)]
    pub(super) name: Option<String>,
    #[serde(default)]
    pub(super) context: Option<String>,
    #[serde(default)]
    pub(super) conclusion: Option<String>,
    #[serde(default)]
    pub(super) state: Option<String>,
}

impl GhCheck {
    pub(super) fn name(&self) -> String {
        self.name
            .clone()
            .or_else(|| self.context.clone())
            .unwrap_or_else(|| "check".to_string())
    }

    /// Display check result. A SUCCESS conclusion (or SUCCESS state) passes;
    /// NEUTRAL/SKIPPED stay distinct; a present non-success conclusion (or
    /// FAILURE/ERROR state) fails; anything still in flight (no conclusion and
    /// a pending/absent state) is "pending" rather than collapsed into a failure.
    pub(super) fn status(&self) -> &'static str {
        if let Some(c) = &self.conclusion {
            return match c.as_str() {
                "SUCCESS" => "pass",
                "NEUTRAL" | "SKIPPED" => "skipped",
                "" => "pending",
                _ => "fail",
            };
        }
        match self.state.as_deref() {
            Some("SUCCESS") => "pass",
            Some("FAILURE") | Some("ERROR") => "fail",
            _ => "pending",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GhPrDetail {
    pub(super) number: u64,
    pub(super) title: String,
    pub(super) state: String,
    pub(super) head_ref_name: String,
    pub(super) base_ref_name: String,
    pub(super) author: GhAuthor,
    pub(super) created_at: String,
    pub(super) additions: u64,
    pub(super) deletions: u64,
    pub(super) changed_files: u64,
    pub(super) is_draft: bool,
    pub(super) url: String,
    #[serde(default)]
    pub(super) body: String,
    #[serde(default)]
    pub(super) comments: Vec<GhComment>,
    #[serde(default)]
    pub(super) files: Vec<GhFile>,
    #[serde(default)]
    pub(super) mergeable: String,
    #[serde(default)]
    pub(super) review_requests: Vec<GhReviewer>,
    #[serde(default)]
    pub(super) reviews: Vec<GhReview>,
    #[serde(default)]
    pub(super) assignees: Vec<GhAuthor>,
    #[serde(default)]
    pub(super) labels: Vec<GhLabel>,
    #[serde(default)]
    pub(super) milestone: Option<GhMilestone>,
    #[serde(default)]
    pub(super) commits: Vec<GhCommit>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GhChecksOnly {
    #[serde(default)]
    pub(super) status_check_rollup: Vec<GhCheck>,
}

// ---- GraphQL review-thread response shapes ----

#[derive(Deserialize)]
pub(super) struct GqlThreadsResp {
    pub(super) data: GqlThreadsData,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GqlThreadsData {
    pub(super) repository: GqlThreadsRepo,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GqlThreadsRepo {
    pub(super) pull_request: GqlThreadsPr,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GqlThreadsPr {
    pub(super) review_threads: GqlNodes<GqlThread>,
}
#[derive(Deserialize)]
pub(super) struct GqlNodes<T> {
    pub(super) nodes: Vec<T>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GqlThread {
    pub(super) id: String,
    #[serde(default)]
    pub(super) path: String,
    pub(super) line: Option<u32>,
    #[serde(default)]
    pub(super) is_resolved: bool,
    #[serde(default)]
    pub(super) is_outdated: bool,
    pub(super) comments: GqlNodes<GqlThreadComment>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GqlThreadComment {
    pub(super) author: Option<GqlAuthor>,
    #[serde(default)]
    pub(super) body: String,
    #[serde(default)]
    pub(super) created_at: String,
}
#[derive(Deserialize)]
pub(super) struct GqlAuthor {
    #[serde(default)]
    pub(super) login: String,
}

impl GqlThread {
    pub(super) fn into_thread(self) -> ReviewThread {
        ReviewThread {
            id: self.id,
            path: self.path,
            line: self.line,
            is_resolved: self.is_resolved,
            is_outdated: self.is_outdated,
            comments: self
                .comments
                .nodes
                .into_iter()
                .map(|c| {
                    // A deleted author serializes as null; fall back to "ghost".
                    let login = c.author.map(|a| a.login).unwrap_or_default();
                    let name = if login.is_empty() {
                        "ghost".to_string()
                    } else {
                        login.clone()
                    };
                    PrComment {
                        author: PrAuthor { name, login },
                        body: c.body,
                        created_at: c.created_at,
                    }
                })
                .collect(),
        }
    }
}

// ---- GraphQL commit-signature response shapes ----
//
// `gh pr view --json commits` carries no signature data, so per-commit
// verification comes from a separate GraphQL read (PullRequest.commits → commit
// → signature). An unsigned commit serializes `signature: null`.

#[derive(Deserialize)]
pub(super) struct GqlCommitsResp {
    pub(super) data: GqlCommitsData,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GqlCommitsData {
    pub(super) repository: GqlCommitsRepo,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GqlCommitsRepo {
    pub(super) pull_request: GqlCommitsPr,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GqlCommitsPr {
    pub(super) commits: GqlNodes<GqlCommitNode>,
}
#[derive(Deserialize)]
pub(super) struct GqlCommitNode {
    pub(super) commit: GqlSignedCommit,
}
#[derive(Deserialize)]
pub(super) struct GqlSignedCommit {
    pub(super) oid: String,
    #[serde(default)]
    pub(super) signature: Option<GqlSignature>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GqlSignature {
    #[serde(default)]
    pub(super) is_valid: bool,
}

impl GqlCommitNode {
    pub(super) fn into_signature(self) -> PrCommitSignature {
        // Verified only when GitHub itself reports a valid signature.
        let verified = self.commit.signature.map(|s| s.is_valid).unwrap_or(false);
        PrCommitSignature {
            oid: self.commit.oid,
            verified,
        }
    }
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
        assert_eq!(gh_check(None, None, Some("SUCCESS"), None).status(), "pass");
    }

    #[test]
    fn check_keeps_neutral_or_skipped_conclusion_distinct() {
        assert_eq!(gh_check(None, None, Some("NEUTRAL"), None).status(), "skipped");
        assert_eq!(gh_check(None, None, Some("SKIPPED"), None).status(), "skipped");
    }

    #[test]
    fn check_fails_on_failure_conclusion() {
        assert_eq!(gh_check(None, None, Some("FAILURE"), None).status(), "fail");
        assert_eq!(gh_check(None, None, Some("TIMED_OUT"), None).status(), "fail");
        // A failing conclusion wins even when the state field looks healthy.
        assert_eq!(
            gh_check(None, None, Some("FAILURE"), Some("SUCCESS")).status(),
            "fail"
        );
    }

    #[test]
    fn check_falls_back_to_state_when_no_conclusion() {
        assert_eq!(gh_check(None, None, None, Some("SUCCESS")).status(), "pass");
        // In-flight checks are pending, NOT collapsed into a failure.
        assert_eq!(gh_check(None, None, None, Some("PENDING")).status(), "pending");
        assert_eq!(gh_check(None, None, None, None).status(), "pending");
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
    fn commit_signature_verified_only_when_valid() {
        // Valid signature → verified.
        let valid: GqlCommitNode =
            serde_json::from_str(r#"{"commit":{"oid":"a","signature":{"isValid":true}}}"#).unwrap();
        assert!(valid.into_signature().verified);

        // Present-but-invalid signature → not verified.
        let invalid: GqlCommitNode =
            serde_json::from_str(r#"{"commit":{"oid":"b","signature":{"isValid":false}}}"#)
                .unwrap();
        let s = invalid.into_signature();
        assert_eq!(s.oid, "b");
        assert!(!s.verified);

        // Unsigned commit (null signature) → not verified.
        let unsigned: GqlCommitNode =
            serde_json::from_str(r#"{"commit":{"oid":"c","signature":null}}"#).unwrap();
        assert!(!unsigned.into_signature().verified);
    }

    #[test]
    fn commit_takes_first_of_multiple_authors() {
        let c: GhCommit = serde_json::from_str(
            r#"{"oid":"a","authors":[{"login":"first","name":"First"},{"login":"second","name":"Second"}]}"#,
        )
        .unwrap();
        assert_eq!(c.into_commit().author_login, "first");
    }

    // ---- deleted comment authors (GqlThread::into_thread) ----

    #[test]
    fn deleted_thread_author_renders_as_ghost() {
        let thread = GqlThread {
            id: "T_1".into(),
            path: "src/foo.rs".into(),
            line: Some(10),
            is_resolved: false,
            is_outdated: false,
            comments: GqlNodes {
                nodes: vec![
                    GqlThreadComment {
                        author: None,
                        body: "deleted user".into(),
                        created_at: "t".into(),
                    },
                    GqlThreadComment {
                        author: Some(GqlAuthor {
                            login: "octocat".into(),
                        }),
                        body: "alive".into(),
                        created_at: "t".into(),
                    },
                ],
            },
        };
        let mapped = thread.into_thread();
        assert_eq!(mapped.comments.len(), 2);
        // null author → login empty, display name "ghost".
        assert_eq!(mapped.comments[0].author.login, "");
        assert_eq!(mapped.comments[0].author.name, "ghost");
        // present author → name == login.
        assert_eq!(mapped.comments[1].author.login, "octocat");
        assert_eq!(mapped.comments[1].author.name, "octocat");
        assert_eq!(mapped.line, Some(10));
        assert!(!mapped.is_resolved);
    }
}
