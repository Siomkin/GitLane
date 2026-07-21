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

use crate::git::oauth::http::{HttpError, HttpResult, HttpTransport, PROVIDER_JSON_RESPONSE_LIMIT};

use super::super::domain::GithubError;

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

/// Direct Bitbucket Cloud REST 2.0 client over the shared [`HttpTransport`],
/// authenticating with a GitLane-owned keychain token as an `Authorization:
/// Bearer` header (works for OAuth access tokens and Bitbucket Access Tokens).
pub struct RestClient<'a> {
    http: &'a dyn HttpTransport,
    /// The repo host (`bitbucket.org`), for actionable auth errors only.
    host: String,
    /// The account's git HTTPS username — [`OAUTH_USERNAME`] for an OAuth token
    /// (→ Bearer) or a real username for an API token / app password (→ Basic).
    username: String,
    token: String,
}

impl<'a> RestClient<'a> {
    pub fn new(http: &'a dyn HttpTransport, host: &str, username: &str, token: &str) -> Self {
        Self {
            http,
            host: host.to_string(),
            username: username.to_string(),
            token: token.to_string(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{API_BASE}/{path}")
    }

    /// The `Authorization` header value: Bearer for an OAuth token (the
    /// `x-token-auth` sentinel username), Basic `username:token` otherwise. An
    /// empty username is treated as OAuth (Bearer) — a Basic realm needs a
    /// username, so this is the safe default.
    fn auth_header(&self) -> String {
        let user = self.username.trim();
        if user.is_empty() || user == OAUTH_USERNAME {
            format!("Bearer {}", self.token)
        } else {
            let creds =
                base64::engine::general_purpose::STANDARD.encode(format!("{user}:{}", self.token));
            format!("Basic {creds}")
        }
    }

    fn redact_error_text(&self, text: &str) -> String {
        if self.token.is_empty() {
            return crate::redact::redact_secrets_with_values(text, &[]);
        }

        let auth = self.auth_header();
        let header = format!("Authorization: {auth}");
        let payload = auth.strip_prefix("Basic ").unwrap_or("");
        crate::redact::redact_secrets_with_values(
            text,
            &[header.as_str(), auth.as_str(), payload, self.token.as_str()],
        )
    }

    /// Preserve the category chosen from the original status/detail and redact
    /// only the message that can escape through GithubError and IPC.
    fn redact_error(&self, error: GithubError) -> GithubError {
        match error {
            GithubError::Network(message) => GithubError::Network(self.redact_error_text(&message)),
            GithubError::InvalidResponse(message) => {
                GithubError::InvalidResponse(self.redact_error_text(&message))
            }
            GithubError::CommandFailed(message) => {
                GithubError::CommandFailed(self.redact_error_text(&message))
            }
            other => other,
        }
    }

    fn finish(&self, operation: &'static str, result: HttpResult) -> Result<String, GithubError> {
        match result {
            Ok(resp) if resp.is_success() => Ok(resp.body),
            Ok(resp) => {
                let error = map_http_error(operation, &self.host, resp.status, &resp.body);
                Err(self.redact_error(error))
            }
            Err(HttpError::ResponseTooLarge { limit }) => Err(GithubError::InvalidResponse(
                format!(
                    "Bitbucket {operation} exceeded the {limit}-byte response limit; the partial response was discarded."
                ),
            )),
            // A transport adapter may echo its headers. Scrub the active bearer
            // or Basic credential as well as any URL-carried credential.
            Err(HttpError::Transport(err)) => {
                Err(GithubError::Network(self.redact_error_text(&err)))
            }
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
        self.finish(
            operation,
            self.http
                .get_with_limit(&self.url(path), &headers, PROVIDER_JSON_RESPONSE_LIMIT),
        )
    }

    fn get_text(&self, operation: &'static str, path: &str) -> Result<String, GithubError> {
        let auth = self.auth_header();
        let headers = [("Authorization", auth.as_str()), ("Accept", "text/plain")];
        self.finish(
            operation,
            self.http
                .get_with_limit(&self.url(path), &headers, DIFF_RESPONSE_LIMIT),
        )
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
        self.finish(
            operation,
            self.http.post_json_with_limit(
                &self.url(path),
                body,
                &headers,
                PROVIDER_JSON_RESPONSE_LIMIT,
            ),
        )
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
mod tests {
    use super::*;
    use crate::git::oauth::http::{testing::MockTransport, DEFAULT_RESPONSE_LIMIT};

    #[test]
    fn ordinary_json_can_exceed_the_oauth_response_limit() {
        let body = format!(r#"{{"padding":"{}"}}"#, "x".repeat(DEFAULT_RESPONSE_LIMIT));
        let http = MockTransport::new(vec![MockTransport::ok(200, &body)]);
        let client = RestClient::new(&http, "bitbucket.org", OAUTH_USERNAME, "tok");

        assert_eq!(
            client
                .get("detail", "repositories/a/b/pullrequests/1")
                .unwrap(),
            body
        );
        assert_eq!(
            http.requests.lock().unwrap()[0].max_bytes,
            PROVIDER_JSON_RESPONSE_LIMIT
        );
    }

    #[test]
    fn mutation_json_uses_the_provider_response_limit() {
        let body = format!(r#"{{"padding":"{}"}}"#, "x".repeat(DEFAULT_RESPONSE_LIMIT));
        let http = MockTransport::new(vec![MockTransport::ok(200, &body)]);
        let client = RestClient::new(&http, "bitbucket.org", OAUTH_USERNAME, "tok");

        assert_eq!(
            client
                .post_json("create", "repositories/a/b/pullrequests", "{}")
                .unwrap(),
            body
        );
        assert_eq!(
            http.requests.lock().unwrap()[0].max_bytes,
            PROVIDER_JSON_RESPONSE_LIMIT
        );

        let oversized = "x".repeat(PROVIDER_JSON_RESPONSE_LIMIT + 1);
        let http = MockTransport::new(vec![MockTransport::ok(200, &oversized)]);
        let client = RestClient::new(&http, "bitbucket.org", OAUTH_USERNAME, "tok");
        assert!(matches!(
            client.post_json("merge", "repositories/a/b/pullrequests/1/merge", "{}"),
            Err(GithubError::InvalidResponse(_))
        ));
    }

    fn auth_header_for(username: &str) -> String {
        let http = MockTransport::new(vec![MockTransport::ok(200, "{}")]);
        let client = RestClient::new(&http, "bitbucket.org", username, "tok");
        client.get("probe", "user").expect("get");
        let reqs = http.requests.lock().unwrap();
        reqs[0]
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
            .map(|(_, v)| v.clone())
            .expect("authorization header")
    }

    #[test]
    fn oauth_username_uses_bearer_others_use_basic() {
        // OAuth sentinel (and an empty username) → Bearer.
        assert_eq!(auth_header_for(OAUTH_USERNAME), "Bearer tok");
        assert_eq!(auth_header_for(""), "Bearer tok");
        // A real username (API token / app password) → Basic base64(user:token).
        let expected = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode("alice:tok")
        );
        assert_eq!(auth_header_for("alice"), expected);
    }

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
        // A bare 403 (no body) stays a generic permission error.
        assert!(matches!(
            map_http_error("merge", "bitbucket.org", 403, ""),
            GithubError::PermissionDenied { .. }
        ));
        // A 403 whose body names insufficient scopes surfaces that text plus a
        // re-authorize hint (an OAuth grant predating the PR scopes, GL-141).
        match map_http_error(
            "approve",
            "bitbucket.org",
            403,
            r#"{"type":"error","error":{"message":"Your credentials lack one or more required privilege scopes."}}"#,
        ) {
            GithubError::CommandFailed(msg) => {
                assert!(msg.contains("privilege scopes"), "{msg}");
                assert!(msg.contains("Re-authorize"), "{msg}");
            }
            other => panic!("expected CommandFailed for a scope 403, got {other:?}"),
        }
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

    #[test]
    fn oversized_diff_is_a_typed_invalid_response_not_a_partial_success() {
        let http = MockTransport::new(vec![]);
        let client = RestClient::new(&http, "bitbucket.org", OAUTH_USERNAME, "tok");

        let result = client.finish(
            "pull request diff",
            Err(HttpError::ResponseTooLarge {
                limit: DIFF_RESPONSE_LIMIT,
            }),
        );

        match result {
            Err(GithubError::InvalidResponse(message)) => {
                assert!(
                    message.contains("partial response was discarded"),
                    "{message}"
                );
                assert!(
                    message.contains(&DIFF_RESPONSE_LIMIT.to_string()),
                    "{message}"
                );
            }
            other => panic!("expected typed invalid response, got {other:?}"),
        }
    }

    #[test]
    fn basic_rest_errors_redact_token_header_payload_and_url_credentials() {
        let token = "bitbucket-app-password";
        let http = MockTransport::new(vec![]);
        let client = RestClient::new(&http, "bitbucket.org", "alice", token);
        let payload = base64::engine::general_purpose::STANDARD.encode(format!("alice:{token}"));
        let auth = format!("Basic {payload}");
        let header = format!("Authorization: {auth}");
        let json = format!(
            r#"{{"error":{{"message":"token={token}; auth={auth}; header={header}; payload={payload}; url=https://alice:url-secret@bitbucket.org/a/b"}}}}"#
        );

        let response = client.finish("detail", MockTransport::ok(404, &json));
        let Err(GithubError::CommandFailed(message)) = response else {
            panic!("expected command failure");
        };
        for secret in [
            token,
            auth.as_str(),
            header.as_str(),
            payload.as_str(),
            "url-secret",
        ] {
            assert!(!message.contains(secret), "leaked {secret:?}: {message}");
        }
        assert!(
            message.contains("https://alice:***@bitbucket.org/a/b"),
            "{message}"
        );

        // Drive the text endpoint through its real transport seam. A non-JSON
        // error body keeps the existing generic category/message and cannot
        // expose echoed headers.
        let text = format!("upstream echoed {header} payload={payload}");
        let text_http = MockTransport::new(vec![MockTransport::ok(500, &text)]);
        let text_client = RestClient::new(&text_http, "bitbucket.org", "alice", token);
        let Err(GithubError::CommandFailed(message)) =
            text_client.get_text("pull request diff", "repositories/a/b/pullrequests/1/diff")
        else {
            panic!("expected command failure");
        };
        for secret in [token, auth.as_str(), payload.as_str()] {
            assert!(!message.contains(secret), "leaked {secret:?}: {message}");
        }
        assert_eq!(text_http.requests.lock().unwrap()[0].method, "GET");
        assert_eq!(
            text_http.requests.lock().unwrap()[0]
                .headers
                .iter()
                .find(|(key, _)| key == "Accept")
                .map(|(_, value)| value.as_str()),
            Some("text/plain")
        );

        let transport = format!("request failed with {header} payload={payload}");
        let Err(GithubError::Network(message)) =
            client.finish("detail", Err(HttpError::Transport(transport)))
        else {
            panic!("expected network failure");
        };
        for secret in [token, auth.as_str(), header.as_str(), payload.as_str()] {
            assert!(!message.contains(secret), "leaked {secret:?}: {message}");
        }
    }

    #[test]
    fn basic_rest_errors_redact_encoded_token_auth_and_padded_payload() {
        let token = "bit bucket=Z!";
        let encoded_token = "bit+bucket%3d%5A%21";
        let payload = "YWxpY2U6Yml0IGJ1Y2tldD1aIQ==";
        let encoded_payload = "YWxpY2U6Yml0IGJ1Y2tldD1aIQ%3d%3D";
        let encoded_auth = "Basic+YWxpY2U6Yml0IGJ1Y2tldD1aIQ%3D%3d";
        let encoded_header = "Authorization%3a+Basic%20YWxpY2U6Yml0IGJ1Y2tldD1aIQ=%3D";
        let http = MockTransport::new(vec![]);
        let client = RestClient::new(&http, "bitbucket.org", "alice", token);
        assert_eq!(
            client.auth_header(),
            format!("Basic {payload}"),
            "fixture must cover the client's exact padded Basic payload"
        );
        let body = format!(
            r#"{{"error":{{"message":"https://{encoded_token}@bitbucket.org/a/b?token={encoded_token}&payload={encoded_payload}&auth={encoded_auth}&header={encoded_header}"}}}}"#
        );

        let error = client
            .finish("detail", MockTransport::ok(404, &body))
            .expect_err("encoded credential echo must fail");
        assert!(matches!(error, GithubError::CommandFailed(_)));

        let debug = format!("{error:?}");
        let ipc = error.to_ipc_string();
        for exposed in [
            token,
            encoded_token,
            payload,
            encoded_payload,
            encoded_auth,
            encoded_header,
        ] {
            assert!(
                !debug.contains(exposed),
                "debug leaked {exposed:?}: {debug}"
            );
            assert!(!ipc.contains(exposed), "IPC leaked {exposed:?}: {ipc}");
        }
        assert!(ipc.contains("https://***@bitbucket.org/a/b"), "{ipc}");
    }

    #[test]
    fn bearer_rest_errors_are_redacted_and_scope_categorization_is_unchanged() {
        // The active secret itself contains "scope". The 403 upgrade must inspect
        // that original detail before redaction removes the token from the outward
        // message, otherwise the re-authorization guidance would be lost.
        let token = "required-scope-secret";
        let http = MockTransport::new(vec![]);
        let client = RestClient::new(&http, "bitbucket.org", OAUTH_USERNAME, token);
        let body = format!(r#"{{"error":{{"message":"{token}"}}}}"#);
        let response = client.finish("approve", MockTransport::ok(403, &body));
        let Err(GithubError::CommandFailed(message)) = response else {
            panic!("expected categorized scope failure");
        };
        assert!(!message.contains(token), "{message}");
        assert!(message.contains("Re-authorize"), "{message}");

        let empty = RestClient::new(&http, "bitbucket.org", OAUTH_USERNAME, "");
        let response = empty.finish(
            "detail",
            MockTransport::ok(
                404,
                r#"{"error":{"message":"Bearer authentication failed"}}"#,
            ),
        );
        assert_eq!(
            response,
            Err(GithubError::CommandFailed(
                "Bearer authentication failed".to_string()
            ))
        );
    }
}
