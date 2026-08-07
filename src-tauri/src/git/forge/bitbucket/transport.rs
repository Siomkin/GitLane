//! Transport for Bitbucket Cloud REST API 2.0 (GL-141).
//!
//! Unlike GitLab (which has the `glab` CLI) Bitbucket ships no first-party CLI, so
//! there is a single transport: a direct HTTP client over the shared
//! [`HttpTransport`], authenticating with a GitLane-owned keychain token. The
//! scheme follows the account's git HTTPS username, exactly as git transport does
//! (GL-132/GL-139):
//! - an **OAuth** access token authenticates as the sentinel `x-token-auth`
//!   ([`OAUTH_USERNAME`]) → `Authorization: Bearer`, the documented OAuth scheme;
//! - a manually-stored **API token / app password** carries a real username →
//!   `Authorization: Basic base64(username:token)`, which is how Bitbucket accepts
//!   those credentials (Bearer only fits OAuth/access tokens).
//!
//! The token stays in this process, riding only in the request header, never a URL
//! or log. Confining the client behind the [`BitbucketApi`] trait lets
//! [`super::ops`] be written once and unit-tested against the mock transport with
//! no network.
//!
//! The API authority is the fixed `api.bitbucket.org` (Bitbucket Cloud only —
//! Server/Data Center has a different API and is out of scope); the repo host
//! (`bitbucket.org`) is carried only for actionable auth errors.

use base64::Engine as _;
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
pub(super) const DIFF_RESPONSE_LIMIT: usize = 32 * 1024 * 1024;

/// The git HTTPS username a Bitbucket **OAuth** access token authenticates as
/// (matches `oauth::config`'s `transport_username` for Bitbucket). When the
/// account's username is this sentinel, the REST client uses Bearer auth; any
/// other username is a real credential and uses Basic auth.
pub const OAUTH_USERNAME: &str = "x-token-auth";

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

/// The `Authorization` header value: Bearer for an OAuth token (the
/// `x-token-auth` sentinel username), Basic `username:token` otherwise. An
/// empty username is treated as OAuth (Bearer) — a Basic realm needs a
/// username, so this is the safe default.
fn auth_header(username: &str, token: &str) -> String {
    let user = username.trim();
    if user.is_empty() || user == OAUTH_USERNAME {
        format!("Bearer {token}")
    } else {
        let creds = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{token}"));
        format!("Basic {creds}")
    }
}

/// Direct Bitbucket Cloud REST 2.0 client, a thin adapter over the shared
/// [`rest::RestClient`] (GL-361): Bitbucket supplies the fixed [`API_BASE`],
/// the scheme its username selects (via [`auth_header`], with the Basic
/// payload declared as an extra secret so it can never escape), and
/// [`map_http_error`]; the shared client owns the verbs, response finishing,
/// and secret redaction.
pub struct RestClient<'a> {
    rest: rest::RestClient<'a>,
}

impl<'a> RestClient<'a> {
    pub fn new(http: &'a dyn HttpTransport, host: &str, username: &str, token: &str) -> Self {
        let auth = auth_header(username, token);
        let payload = auth.strip_prefix("Basic ").unwrap_or("").to_string();
        Self {
            rest: rest::RestClient::new(
                http,
                rest::RestConfig {
                    provider: "Bitbucket",
                    base_url: API_BASE.to_string(),
                    host,
                    auth: auth.clone(),
                    token,
                    extra_secrets: &[payload.as_str()],
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
        // Bitbucket-specific guidance, not the gh-worded NotAuthenticated string.
        401 => super::no_bitbucket_auth(host),
        // A 403 from an OAuth grant that predates GL-141 means the token lacks the
        // `pullrequest` scopes: Bitbucket says so in the body ("… required
        // privilege scopes"). Surface that with a re-authorize hint instead of the
        // generic "permission denied", which wouldn't tell the user how to fix it.
        403 => match detail {
            Some(msg) if msg.to_ascii_lowercase().contains("scope") => {
                GithubError::CommandFailed(format!(
                    "{msg} Re-authorize your Bitbucket account in Settings to grant pull-request access."
                ))
            }
            Some(msg) => GithubError::CommandFailed(msg),
            None => GithubError::PermissionDenied { operation },
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
