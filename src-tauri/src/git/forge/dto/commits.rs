use serde::Deserialize;

use super::{GqlAuthor, GqlNodes};
use crate::git::types::PrCommit;

// ---- GraphQL commit-signature response shapes ----
//
// `gh pr view --json commits` caps the projection at GitHub's limit and carries
// no signature data, so the authoritative commit list (with per-commit
// verification) comes from this paginated GraphQL read (PullRequest.commits →
// commit → …). An unsigned commit serializes `signature: null`.

#[derive(Deserialize)]
pub(in crate::git::forge) struct GqlCommitsResp {
    pub(in crate::git::forge) data: GqlCommitsData,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlCommitsData {
    pub(in crate::git::forge) repository: GqlCommitsRepo,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlCommitsRepo {
    pub(in crate::git::forge) pull_request: GqlCommitsPr,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlCommitsPr {
    pub(in crate::git::forge) commits: GqlNodes<GqlCommitNode>,
}
#[derive(Deserialize)]
pub(in crate::git::forge) struct GqlCommitNode {
    pub(in crate::git::forge) commit: GqlSignedCommit,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlSignedCommit {
    pub(in crate::git::forge) oid: String,
    #[serde(default)]
    pub(in crate::git::forge) message_headline: String,
    #[serde(default)]
    pub(in crate::git::forge) authored_date: String,
    #[serde(default)]
    pub(in crate::git::forge) signature: Option<GqlSignature>,
    #[serde(default)]
    pub(in crate::git::forge) author: Option<GqlCommitAuthor>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlCommitAuthor {
    #[serde(default)]
    pub(in crate::git::forge) name: String,
    #[serde(default)]
    pub(in crate::git::forge) user: Option<GqlAuthor>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::git::forge) struct GqlSignature {
    #[serde(default)]
    pub(in crate::git::forge) is_valid: bool,
}

impl GqlCommitNode {
    pub(in crate::git::forge) fn into_commit(self) -> PrCommit {
        let c = self.commit;
        // Verified only when GitHub itself reports a valid signature.
        let verified = c.signature.map(|s| s.is_valid).unwrap_or(false);
        // Prefer the GitHub login; fall back to the display name, then empty.
        let author_login = c
            .author
            .as_ref()
            .and_then(|a| a.user.as_ref())
            .map(|u| u.login.clone())
            .unwrap_or_default();
        let author_name = c
            .author
            .map(|a| a.name)
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| author_login.clone());
        PrCommit {
            oid: c.oid,
            headline: c.message_headline,
            authored_date: c.authored_date,
            author_name,
            author_login,
            verified,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gql_commit_verified_only_when_signature_is_valid() {
        // Valid signature → verified, and metadata rides along.
        let valid: GqlCommitNode = serde_json::from_str(
            r#"{"commit":{"oid":"a","messageHeadline":"feat: x","authoredDate":"2026-06-22T07:01:01Z",
                "signature":{"isValid":true},"author":{"name":"Octo Cat","user":{"login":"octocat"}}}}"#,
        )
        .unwrap();
        let c = valid.into_commit();
        assert!(c.verified);
        assert_eq!(c.headline, "feat: x");
        assert_eq!(c.authored_date, "2026-06-22T07:01:01Z");
        assert_eq!(c.author_name, "Octo Cat");
        assert_eq!(c.author_login, "octocat");

        // Present-but-invalid signature → not verified.
        let invalid: GqlCommitNode =
            serde_json::from_str(r#"{"commit":{"oid":"b","signature":{"isValid":false}}}"#)
                .unwrap();
        let c = invalid.into_commit();
        assert_eq!(c.oid, "b");
        assert!(!c.verified);

        // Unsigned commit (null signature) → not verified.
        let unsigned: GqlCommitNode =
            serde_json::from_str(r#"{"commit":{"oid":"c","signature":null}}"#).unwrap();
        assert!(!unsigned.into_commit().verified);
    }

    #[test]
    fn gql_commit_author_falls_back_from_name_to_login_to_empty() {
        // No display name → use the login.
        let login_only: GqlCommitNode = serde_json::from_str(
            r#"{"commit":{"oid":"a","author":{"name":"","user":{"login":"octocat"}}}}"#,
        )
        .unwrap();
        let c = login_only.into_commit();
        assert_eq!(c.author_name, "octocat");
        assert_eq!(c.author_login, "octocat");

        // No author at all → both empty.
        let none: GqlCommitNode = serde_json::from_str(r#"{"commit":{"oid":"a"}}"#).unwrap();
        let c = none.into_commit();
        assert_eq!(c.author_name, "");
        assert_eq!(c.author_login, "");
    }
}
