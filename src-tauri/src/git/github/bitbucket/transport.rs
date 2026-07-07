//! Transport for Bitbucket Cloud REST API 2.0 (GL-141).
//!
//! Unlike GitLab (which has the `glab` CLI) Bitbucket ships no first-party CLI, so
//! there is a single transport: a direct HTTP client over the shared
//! [`HttpTransport`], authenticating with a GitLane-owned keychain token as a
//! `Authorization: Bearer` header. Bearer is the documented scheme for the OAuth
//! access tokens this builds on (GL-139) and for Bitbucket Access Tokens; the
//! token stays in this process, riding only in the request header, never a URL or
//! log. Confining the client behind the [`BitbucketApi`] trait lets [`super::ops`]
//! be written once and unit-tested against the mock transport with no network.
//!
//! The API authority is the fixed `api.bitbucket.org` (Bitbucket Cloud only —
//! Server/Data Center has a different API and is out of scope); the repo host
//! (`bitbucket.org`) is carried only for actionable auth errors.

use serde::Deserialize;

use crate::git::oauth::http::HttpTransport;

use super::super::domain::GithubError;

/// The fixed Bitbucket Cloud REST API 2.0 base. Cloud repos are always served
/// here regardless of the `bitbucket.org` web host.
const API_BASE: &str = "https://api.bitbucket.org/2.0";

/// A Bitbucket Cloud REST 2.0 transport. `path` is an API path relative to the
/// `/2.0` base (e.g. `repositories/team/app/pullrequests?state=OPEN`), already
/// carrying any query string for a GET. Write verbs take a raw JSON body —
/// Bitbucket's create/merge endpoints read nested JSON, not a form.
pub trait BitbucketApi {
    fn get(&self, operation: &'static str, path: &str) -> Result<String, GithubError>;
    fn post_json(
        &self,
        operation: &'static str,
        path: &str,
        body: &str,
    ) -> Result<String, GithubError>;
}

/// Direct Bitbucket Cloud REST 2.0 client over the shared [`HttpTransport`],
/// authenticating with a GitLane-owned keychain token as an `Authorization:
/// Bearer` header (works for OAuth access tokens and Bitbucket Access Tokens).
pub struct RestClient<'a> {
    http: &'a dyn HttpTransport,
    /// The repo host (`bitbucket.org`), for actionable auth errors only.
    host: String,
    token: String,
}

impl<'a> RestClient<'a> {
    pub fn new(http: &'a dyn HttpTransport, host: &str, token: &str) -> Self {
        Self {
            http,
            host: host.to_string(),
            token: token.to_string(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{API_BASE}/{path}")
    }

    fn auth_header(&self) -> String {
        format!("Bearer {}", self.token)
    }

    fn finish(
        &self,
        operation: &'static str,
        result: Result<crate::git::oauth::http::HttpResponse, String>,
    ) -> Result<String, GithubError> {
        match result {
            Ok(resp) if resp.is_success() => Ok(resp.body),
            Ok(resp) => Err(map_http_error(operation, &self.host, resp.status, &resp.body)),
            // A transport failure message may quote the request URL (never a
            // secret — the token rides in a header), but redact defensively.
            Err(err) => Err(GithubError::Network(crate::redact::redact_secrets(&err))),
        }
    }
}

impl BitbucketApi for RestClient<'_> {
    fn get(&self, operation: &'static str, path: &str) -> Result<String, GithubError> {
        let auth = self.auth_header();
        let headers = [
            ("Authorization", auth.as_str()),
            ("Accept", "application/json"),
        ];
        self.finish(operation, self.http.get(&self.url(path), &headers))
    }

    fn post_json(
        &self,
        operation: &'static str,
        path: &str,
        body: &str,
    ) -> Result<String, GithubError> {
        let auth = self.auth_header();
        let headers = [
            ("Authorization", auth.as_str()),
            ("Accept", "application/json"),
        ];
        self.finish(operation, self.http.post_json(&self.url(path), body, &headers))
    }
}

/// Map a non-2xx Bitbucket HTTP status onto an internal category, extracting
/// Bitbucket's own error message from the JSON body when present.
fn map_http_error(operation: &'static str, host: &str, status: u16, body: &str) -> GithubError {
    let detail = bitbucket_message(body);
    match status {
        // Bitbucket-specific guidance, not the gh-worded NotAuthenticated string.
        401 => super::no_bitbucket_auth(host),
        403 => GithubError::PermissionDenied { operation },
        404 => GithubError::CommandFailed(
            detail.unwrap_or_else(|| format!("Bitbucket returned 404 for {operation}.")),
        ),
        429 => GithubError::RateLimited { reset_at: None },
        _ => GithubError::CommandFailed(
            detail
                .unwrap_or_else(|| format!("Bitbucket request failed ({status}) for {operation}.")),
        ),
    }
}

/// Best-effort extraction of Bitbucket's error text from a JSON body. Bitbucket
/// wraps errors as `{"type":"error","error":{"message":"…","detail":"…"}}`;
/// prefer `message`, fall back to `detail`.
fn bitbucket_message(body: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Wrapper {
        error: Option<Inner>,
    }
    #[derive(Deserialize)]
    struct Inner {
        #[serde(default)]
        message: Option<String>,
        #[serde(default)]
        detail: Option<String>,
    }
    let parsed: Wrapper = serde_json::from_str(body).ok()?;
    let inner = parsed.error?;
    inner
        .message
        .or(inner.detail)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_bitbucket_error_message() {
        assert_eq!(
            bitbucket_message(r#"{"type":"error","error":{"message":"Bad request"}}"#).as_deref(),
            Some("Bad request")
        );
        // Falls back to `detail` when `message` is absent.
        assert_eq!(
            bitbucket_message(r#"{"error":{"detail":"nope"}}"#).as_deref(),
            Some("nope")
        );
        assert_eq!(bitbucket_message("not json"), None);
        assert_eq!(bitbucket_message(r#"{"error":{}}"#), None);
    }

    #[test]
    fn maps_http_status_to_categories() {
        // 401 → Bitbucket-specific guidance, never gh wording.
        match map_http_error("list", "bitbucket.org", 401, "") {
            GithubError::CommandFailed(msg) => {
                assert!(msg.contains("Bitbucket"), "{msg}");
                assert!(!msg.contains("gh auth"), "{msg}");
            }
            other => panic!("expected CommandFailed for 401, got {other:?}"),
        }
        assert!(matches!(
            map_http_error("merge", "bitbucket.org", 403, ""),
            GithubError::PermissionDenied { .. }
        ));
        assert!(matches!(
            map_http_error("list", "bitbucket.org", 429, ""),
            GithubError::RateLimited { .. }
        ));
        // A 404 surfaces Bitbucket's own message when present.
        match map_http_error(
            "detail",
            "bitbucket.org",
            404,
            r#"{"type":"error","error":{"message":"No such pull request"}}"#,
        ) {
            GithubError::CommandFailed(msg) => assert!(msg.contains("No such pull request")),
            other => panic!("expected CommandFailed, got {other:?}"),
        }
    }
}
