//! Transport for Bitbucket Cloud REST API 2.0 (GL-141).
//!
//! Unlike GitLab (which has the `glab` CLI) Bitbucket ships no first-party CLI, so
//! there is a single transport: a direct HTTP client over the shared
//! [`HttpTransport`], authenticating with a GitLane-owned keychain token. Every
//! token — an OAuth access token (GL-139) or an Atlassian API token (GL-132) — is
//! sent as `Authorization: Bearer`, which Bitbucket documents for both and which
//! needs no Atlassian email. The account's git HTTPS username plays no part here:
//! it matters only to git transport (sending it to the REST API gets a 401 for API
//! tokens, which want the account email instead).
//!
//! The token stays in this process, riding only in the request header, never a URL
//! or log. Confining the client behind the [`BitbucketApi`] trait lets
//! [`super::ops`] be written once and unit-tested against the mock transport with
//! no network.
//!
//! The API authority is the fixed `api.bitbucket.org` (Bitbucket Cloud only —
//! Server/Data Center has a different API and is out of scope); the repo host
//! (`bitbucket.org`) is carried only for actionable auth errors.

use serde::Deserialize;

use crate::git::oauth::http::HttpTransport;

use super::super::domain::GithubError;
use super::super::rest;

/// The fixed Bitbucket Cloud REST API 2.0 base. Cloud repos are always served
/// here regardless of the `bitbucket.org` web host.
const API_BASE: &str = "https://api.bitbucket.org/2.0";

/// Raw PR patches are much larger than OAuth/provider JSON, but still need a
/// hard allocation bound. Bitbucket currently limits a PR diff to 8,000 changed
/// lines, 200 files, and 100 KiB of raw diff per file; 32 MiB covers that stated
/// envelope plus patch metadata while refusing an unexpectedly unbounded body.
pub(super) const DIFF_RESPONSE_LIMIT: usize = super::super::bounded_output::DIFF_STDOUT_LIMIT;

/// A Bitbucket Cloud REST 2.0 transport. `path` is an API path relative to the
/// `/2.0` base (e.g. `repositories/team/app/pullrequests?state=OPEN`), already
/// carrying any query string for a GET. Write verbs take a raw JSON body —
/// Bitbucket's create/merge endpoints read nested JSON, not a form.
pub trait BitbucketApi {
    fn get(&self, operation: &'static str, path: &str) -> Result<String, GithubError>;
    /// GET an endpoint that returns a non-JSON body — the `/diff` endpoint serves
    /// a raw git patch, and requesting `application/json` there makes Bitbucket
    /// answer `406 Not Acceptable`. Sends `Accept: text/plain` instead.
    fn get_text(&self, operation: &'static str, path: &str) -> Result<String, GithubError>;
    fn post_json(
        &self,
        operation: &'static str,
        path: &str,
        body: &str,
    ) -> Result<String, GithubError>;
}

/// Direct Bitbucket Cloud REST 2.0 client, a thin adapter over the shared
/// [`rest::RestClient`] (GL-361): Bitbucket supplies the fixed [`API_BASE`],
/// the Bearer header, and [`map_http_error`]; the shared client owns the verbs,
/// response finishing, and secret redaction.
pub struct RestClient<'a> {
    rest: rest::RestClient<'a>,
}

impl<'a> RestClient<'a> {
    pub fn new(http: &'a dyn HttpTransport, host: &str, token: &str) -> Self {
        Self {
            rest: rest::RestClient::new(
                http,
                rest::RestConfig {
                    provider: "Bitbucket",
                    base_url: API_BASE.to_string(),
                    host,
                    auth: format!("Bearer {token}"),
                    token,
                    extra_secrets: &[],
                    map_error: map_http_error,
                },
            ),
        }
    }
}

impl BitbucketApi for RestClient<'_> {
    fn get(&self, operation: &'static str, path: &str) -> Result<String, GithubError> {
        self.rest.get_json(operation, path)
    }

    fn get_text(&self, operation: &'static str, path: &str) -> Result<String, GithubError> {
        self.rest.get_text(operation, path, DIFF_RESPONSE_LIMIT)
    }

    fn post_json(
        &self,
        operation: &'static str,
        path: &str,
        body: &str,
    ) -> Result<String, GithubError> {
        self.rest.post_json(operation, path, body)
    }
}

/// Map a non-2xx Bitbucket HTTP status onto an internal category, extracting
/// Bitbucket's own error message from the JSON body when present.
fn map_http_error(operation: &'static str, host: &str, status: u16, body: &str) -> GithubError {
    let detail = bitbucket_message(body);
    match status {
        // A token was sent and refused — distinct from "no token saved".
        401 => super::bitbucket_token_rejected(host),
        // A 403 from an OAuth grant that predates GL-141 means the token lacks the
        // `pullrequest` scopes: Bitbucket says so in the body ("… required
        // privilege scopes"). That is an auth problem the user fixes by signing in
        // again, so it carries a re-authorize hint; every other 403 is a plain
        // permission refusal.
        403 => match detail {
            Some(msg) if msg.to_ascii_lowercase().contains("scope") => {
                GithubError::NotAuthenticated {
                    host: host.to_string(),
                    account: None,
                    hint: Some(format!(
                        "{msg} Re-authorize your Bitbucket account in Settings to grant pull-request access."
                    )),
                }
            }
            _ => GithubError::PermissionDenied { operation },
        },
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
mod tests;
