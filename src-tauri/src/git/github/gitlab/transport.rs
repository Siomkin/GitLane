//! Transport for GitLab REST v4 — the glab CLI (zero-config) and a direct HTTP
//! client (keychain-token backed), behind one [`GitlabApi`] trait (GL-140).
//!
//! Both speak the same GitLab REST v4 surface and return raw JSON bodies, so the
//! operations in [`super::ops`] are written once against the trait and parsed via
//! [`super::dto`]. The split mirrors the read/write engine choice elsewhere:
//! [`GlabCli`] shells out to the user's `glab` (which owns its own token, host
//! config, and credentials — zero config); [`RestClient`] is the fallback that
//! authenticates with a GitLane-owned keychain token over the shared
//! [`HttpTransport`], so it unit-tests against a mock with no network.

use std::process::Command;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::git::oauth::http::{HttpError, HttpResult, HttpTransport, PROVIDER_JSON_RESPONSE_LIMIT};

use super::super::bounded_output::{
    self, BoundedOutput, CaptureError, DEFAULT_STDOUT_LIMIT, DIFF_STDOUT_LIMIT, STDERR_LIMIT,
};
use super::super::domain::GithubError;

/// GitLab's MR `/diffs` endpoint can return up to 100 full file patches per
/// page. Ordinary provider JSON has its own bounded allowance, but raw patch
/// bodies still need the larger explicit ceiling shared with Bitbucket diffs.
pub(super) const DIFF_RESPONSE_LIMIT: usize = DIFF_STDOUT_LIMIT;

/// The write verbs the operations need beyond GET.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Post,
    Put,
}

impl Method {
    fn as_str(self) -> &'static str {
        match self {
            Self::Post => "POST",
            Self::Put => "PUT",
        }
    }
}

/// A GitLab REST v4 transport. `path` is an API path relative to `/api/v4`
/// (e.g. `projects/123/merge_requests`), already carrying any query string for a
/// GET. Bodies for POST/PUT are `x-www-form-urlencoded` key/value pairs — GitLab
/// reads MR parameters from the form body.
pub trait GitlabApi {
    fn get(&self, operation: &'static str, path: &str) -> Result<String, GithubError>;
    fn get_with_limit(
        &self,
        operation: &'static str,
        path: &str,
        max_bytes: usize,
    ) -> Result<String, GithubError> {
        let body = self.get(operation, path)?;
        if body.len() > max_bytes {
            Err(GithubError::InvalidResponse(format!(
                "GitLab {operation} exceeded the {max_bytes}-byte response limit; the partial response was discarded."
            )))
        } else {
            Ok(body)
        }
    }
    fn send(
        &self,
        operation: &'static str,
        method: Method,
        path: &str,
        form: &[(&str, &str)],
    ) -> Result<String, GithubError>;
}

// ---- glab CLI ----

/// Cache only a *successful* glab presence probe, like the gh capability cache: a
/// transient spawn failure must not be sticky for the process lifetime.
static GLAB_PRESENT: OnceLock<bool> = OnceLock::new();

/// The single `glab` subprocess site (the GitLab analogue of `run_gh`). Runs
/// `glab <args>` in `workdir` with the augmented PATH macOS GUI apps need, and
/// returns stdout on success or a readable, secret-redacted error.
fn glab_command(workdir: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new("glab");
    cmd.current_dir(workdir).args(args);
    cmd.env("PATH", crate::shell::path());
    // glab resolves repository and authenticated host from cwd. Keep inherited
    // Git routing variables from redirecting that lookup to another checkout.
    crate::git::clear_repository_local_env(&mut cmd);
    crate::shell::hide_console(&mut cmd);
    cmd
}

pub fn run_glab(workdir: &str, args: &[&str]) -> Result<String, String> {
    run_glab_with_limit(workdir, args, DEFAULT_STDOUT_LIMIT)
}

pub fn run_glab_with_limit(
    workdir: &str,
    args: &[&str],
    stdout_limit: usize,
) -> Result<String, String> {
    let mut cmd = glab_command(workdir, args);

    let output = bounded_output::capture(&mut cmd, stdout_limit, STDERR_LIMIT)
        .map_err(map_glab_capture_error)?;

    finish_glab_output(output)
}

fn finish_glab_output(output: BoundedOutput) -> Result<String, String> {
    finish_glab_bytes(
        output.status.success(),
        &output.stdout,
        &output.stderr,
        output.stderr_truncated,
    )
}

fn finish_glab_bytes(
    success: bool,
    stdout: &[u8],
    stderr: &[u8],
    stderr_truncated: bool,
) -> Result<String, String> {
    if success {
        Ok(String::from_utf8_lossy(stdout).to_string())
    } else {
        let stdout = String::from_utf8_lossy(stdout);
        let stderr = String::from_utf8_lossy(stderr);
        let mut combined = format!("{stdout}{stderr}").trim().to_string();
        // Say so rather than passing a clipped tail off as glab's whole message.
        if stderr_truncated {
            combined.push_str(&bounded_output::stderr_truncated_notice());
        }
        Err(crate::redact::redact_secrets(&combined))
    }
}

fn map_glab_capture_error(error: CaptureError) -> String {
    match error {
        CaptureError::Spawn(source) if source.kind() == std::io::ErrorKind::NotFound => {
            GLAB_NOT_FOUND.to_string()
        }
        CaptureError::Spawn(source) => format!("failed to launch glab: {source}"),
        other => format!("glab {other}"),
    }
}

const GLAB_NOT_FOUND: &str =
    "GitLab CLI (glab) not found on PATH. Install glab and run `glab auth login` to use merge requests. GCM/helper or SSH can still handle git transport.";

/// Whether `glab` is installed (`glab --version` succeeds). Cached on success.
/// This is presence only — glab surfaces its own clear error if it is installed
/// but not authenticated for the repo's host.
pub fn glab_available() -> bool {
    if let Some(present) = GLAB_PRESENT.get() {
        return *present;
    }
    let present = run_glab(".", &["--version"]).is_ok();
    if present {
        let _ = GLAB_PRESENT.set(true);
    }
    present
}

/// glab-backed transport: `glab api` runs authenticated REST v4 calls against the
/// GitLab host glab resolves from the repo, returning the same JSON the direct
/// client does. Zero-config — glab owns the token and host.
pub struct GlabCli {
    workdir: String,
}

impl GlabCli {
    pub fn new(workdir: &str) -> Self {
        Self {
            workdir: workdir.to_string(),
        }
    }

    fn run(&self, operation: &'static str, args: &[&str]) -> Result<String, GithubError> {
        run_glab(&self.workdir, args).map_err(|err| map_glab_error(operation, err))
    }

    fn run_with_limit(
        &self,
        operation: &'static str,
        args: &[&str],
        stdout_limit: usize,
    ) -> Result<String, GithubError> {
        run_glab_with_limit(&self.workdir, args, stdout_limit)
            .map_err(|err| map_glab_error(operation, err))
    }
}

impl GitlabApi for GlabCli {
    fn get(&self, operation: &'static str, path: &str) -> Result<String, GithubError> {
        self.run(operation, &["api", path])
    }

    fn get_with_limit(
        &self,
        operation: &'static str,
        path: &str,
        max_bytes: usize,
    ) -> Result<String, GithubError> {
        self.run_with_limit(operation, &["api", path], max_bytes)
    }

    fn send(
        &self,
        operation: &'static str,
        method: Method,
        path: &str,
        form: &[(&str, &str)],
    ) -> Result<String, GithubError> {
        // `glab api --method POST projects/.../merge_requests -f key=value …`.
        // Owned `key=value` strings kept alive for the borrowed args vector.
        let fields: Vec<String> = form.iter().map(|(k, v)| format!("{k}={v}")).collect();
        let mut args: Vec<&str> = vec!["api", "--method", method.as_str(), path];
        for field in &fields {
            args.push("-f");
            args.push(field);
        }
        self.run(operation, &args)
    }
}

/// Map a glab subprocess error onto an internal category. A missing binary is
/// surfaced verbatim (it names the install/sign-in fix); everything else runs
/// through the shared classifier.
fn map_glab_error(operation: &'static str, err: String) -> GithubError {
    if err.contains("glab) not found") {
        return GithubError::CommandFailed(err);
    }
    GithubError::from_command(operation, err)
}

// ---- direct REST client ----

/// Direct GitLab REST v4 client over the shared [`HttpTransport`], authenticating
/// with a GitLane-owned keychain token as an `Authorization: Bearer` header (works
/// for both OAuth access tokens and personal access tokens). The token stays in
/// this process — it rides only in the request header, never a URL or log.
pub struct RestClient<'a> {
    http: &'a dyn HttpTransport,
    /// `https://{host}/api/v4` (host may include a custom port).
    base_url: String,
    /// Normalized host, for actionable auth errors.
    host: String,
    token: String,
}

impl<'a> RestClient<'a> {
    pub fn new(http: &'a dyn HttpTransport, host: &str, token: &str) -> Self {
        Self {
            http,
            base_url: format!("https://{host}/api/v4"),
            host: host.to_string(),
            token: token.to_string(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}/{}", self.base_url, path)
    }

    fn auth_header(&self) -> String {
        format!("Bearer {}", self.token)
    }

    fn redact_error_text(&self, text: &str) -> String {
        if self.token.is_empty() {
            return crate::redact::redact_secrets_with_values(text, &[]);
        }
        let auth = self.auth_header();
        let header = format!("Authorization: {auth}");
        crate::redact::redact_secrets_with_values(
            text,
            &[header.as_str(), auth.as_str(), self.token.as_str()],
        )
    }

    /// Scrub only message-bearing variants after status/detail classification.
    /// Categorization must see the original server response; only the outward
    /// text crossing the provider/IPC boundary is sanitized.
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
                    "GitLab {operation} exceeded the {limit}-byte response limit; the partial response was discarded."
                ),
            )),
            // A transport adapter may echo its request headers as well as its
            // URL. Scrub both URL credentials and this client's active bearer.
            Err(HttpError::Transport(err)) => {
                Err(GithubError::Network(self.redact_error_text(&err)))
            }
        }
    }
}

impl GitlabApi for RestClient<'_> {
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

    fn get_with_limit(
        &self,
        operation: &'static str,
        path: &str,
        max_bytes: usize,
    ) -> Result<String, GithubError> {
        let auth = self.auth_header();
        let headers = [
            ("Authorization", auth.as_str()),
            ("Accept", "application/json"),
        ];
        self.finish(
            operation,
            self.http
                .get_with_limit(&self.url(path), &headers, max_bytes),
        )
    }

    fn send(
        &self,
        operation: &'static str,
        method: Method,
        path: &str,
        form: &[(&str, &str)],
    ) -> Result<String, GithubError> {
        let auth = self.auth_header();
        let headers = [
            ("Authorization", auth.as_str()),
            ("Accept", "application/json"),
        ];
        let url = self.url(path);
        let result = match method {
            Method::Post => {
                self.http
                    .post_form_with_limit(&url, form, &headers, PROVIDER_JSON_RESPONSE_LIMIT)
            }
            Method::Put => {
                self.http
                    .put_form_with_limit(&url, form, &headers, PROVIDER_JSON_RESPONSE_LIMIT)
            }
        };
        self.finish(operation, result)
    }
}

/// Map a non-2xx GitLab HTTP status onto an internal category, extracting
/// GitLab's own error message from the JSON body when present.
fn map_http_error(operation: &'static str, host: &str, status: u16, body: &str) -> GithubError {
    let detail = gitlab_message(body);
    match status {
        // GitLab-specific guidance, not the gh-worded NotAuthenticated string.
        401 => super::no_gitlab_auth(host),
        403 => GithubError::PermissionDenied { operation },
        404 => GithubError::CommandFailed(
            detail.unwrap_or_else(|| format!("GitLab returned 404 for {operation}.")),
        ),
        429 => GithubError::RateLimited { reset_at: None },
        _ => GithubError::CommandFailed(
            detail.unwrap_or_else(|| format!("GitLab request failed ({status}) for {operation}.")),
        ),
    }
}

/// Best-effort extraction of GitLab's error text from a JSON body:
/// `{"message": "…"}` or `{"error": "…"}`. Non-string / structured `message`
/// values (e.g. `{"base": […]}`) fall back to the compact JSON.
fn gitlab_message(body: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct GitlabErr {
        #[serde(default)]
        message: Option<serde_json::Value>,
        #[serde(default)]
        error: Option<String>,
    }
    let parsed: GitlabErr = serde_json::from_str(body).ok()?;
    if let Some(message) = parsed.message {
        return match message {
            serde_json::Value::String(s) if !s.trim().is_empty() => Some(s),
            serde_json::Value::Null => None,
            other => Some(other.to_string()),
        };
    }
    parsed.error.filter(|s| !s.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::oauth::http::{testing::MockTransport, DEFAULT_RESPONSE_LIMIT};
    use std::ffi::OsStr;

    #[test]
    fn glab_commands_clear_repository_local_environment() {
        let command = glab_command(".", &["--version"]);
        for key in crate::git::REPOSITORY_LOCAL_ENV_VARS {
            assert!(
                command
                    .get_envs()
                    .any(|(name, value)| name == OsStr::new(key) && value.is_none()),
                "{key} must be removed from the glab subprocess environment"
            );
        }
    }

    #[test]
    fn missing_glab_copy_is_preserved() {
        let error = map_glab_capture_error(CaptureError::Spawn(std::io::Error::from(
            std::io::ErrorKind::NotFound,
        )));
        assert_eq!(error, GLAB_NOT_FOUND);
    }

    #[test]
    fn bounded_glab_finish_preserves_lossy_and_stream_order_semantics() {
        assert_eq!(
            finish_glab_bytes(true, b"ok\xff", b"ignored stderr", false).unwrap(),
            "ok\u{fffd}"
        );

        let error = finish_glab_bytes(
            false,
            b" stdout first\n",
            b"stderr https://alice:secret@example.test/repo\xff \n",
            false,
        )
        .unwrap_err();
        assert_eq!(
            error,
            "stdout first\nstderr https://alice:***@example.test/repo\u{fffd}"
        );
    }

    #[test]
    fn truncated_glab_diagnostics_are_disclosed_but_never_shown_on_success() {
        assert_eq!(
            finish_glab_bytes(true, b"payload", b"clipped trace", true).unwrap(),
            "payload"
        );

        let error = finish_glab_bytes(false, b"", b"partial trace", true).unwrap_err();
        assert_eq!(
            error,
            format!("partial trace{}", bounded_output::stderr_truncated_notice())
        );
    }

    #[test]
    fn ordinary_json_can_exceed_the_oauth_response_limit() {
        let body = format!(r#"{{"padding":"{}"}}"#, "x".repeat(DEFAULT_RESPONSE_LIMIT));
        let http = MockTransport::new(vec![MockTransport::ok(200, &body)]);
        let client = RestClient::new(&http, "gitlab.com", "tok");

        assert_eq!(
            client.get("detail", "projects/1/merge_requests/1").unwrap(),
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
        let client = RestClient::new(&http, "gitlab.com", "tok");

        assert_eq!(
            client
                .send("create", Method::Post, "projects/1/merge_requests", &[])
                .unwrap(),
            body
        );
        assert_eq!(
            http.requests.lock().unwrap()[0].max_bytes,
            PROVIDER_JSON_RESPONSE_LIMIT
        );

        let oversized = "x".repeat(PROVIDER_JSON_RESPONSE_LIMIT + 1);
        let http = MockTransport::new(vec![MockTransport::ok(200, &oversized)]);
        let client = RestClient::new(&http, "gitlab.com", "tok");
        assert!(matches!(
            client.send(
                "merge",
                Method::Put,
                "projects/1/merge_requests/1/merge",
                &[]
            ),
            Err(GithubError::InvalidResponse(_))
        ));
    }

    #[test]
    fn extracts_gitlab_error_message() {
        assert_eq!(
            gitlab_message(r#"{"message":"403 Forbidden"}"#).as_deref(),
            Some("403 Forbidden")
        );
        assert_eq!(
            gitlab_message(r#"{"error":"invalid_token"}"#).as_deref(),
            Some("invalid_token")
        );
        // Structured message is serialized rather than dropped.
        assert!(gitlab_message(r#"{"message":{"base":["nope"]}}"#).is_some());
        assert_eq!(gitlab_message("not json"), None);
    }

    #[test]
    fn maps_http_status_to_categories() {
        // 401 → GitLab-specific guidance (glab / Settings token), never gh wording.
        match map_http_error("list", "gitlab.com", 401, "") {
            GithubError::CommandFailed(msg) => {
                assert!(msg.contains("glab auth login"), "{msg}");
                assert!(!msg.contains("gh auth"), "{msg}");
            }
            other => panic!("expected CommandFailed for 401, got {other:?}"),
        }
        assert!(matches!(
            map_http_error("merge", "gitlab.com", 403, ""),
            GithubError::PermissionDenied { .. }
        ));
        assert!(matches!(
            map_http_error("list", "gitlab.com", 429, ""),
            GithubError::RateLimited { .. }
        ));
        // A 404 surfaces GitLab's own message when present.
        match map_http_error(
            "detail",
            "gitlab.com",
            404,
            r#"{"message":"404 Not found"}"#,
        ) {
            GithubError::CommandFailed(msg) => assert!(msg.contains("Not found")),
            other => panic!("expected CommandFailed, got {other:?}"),
        }
    }

    #[test]
    fn rest_errors_redact_active_bearer_and_url_credentials() {
        let token = "glpat-live-secret";
        let http = MockTransport::new(vec![]);
        let client = RestClient::new(&http, "gitlab.com", token);
        let auth = format!("Bearer {token}");
        let header = format!("Authorization: {auth}");
        let json = format!(
            r#"{{"message":"token={token}; auth={auth}; header={header}; url=https://alice:url-secret@gitlab.com/g/r"}}"#
        );

        let response = client.finish("detail", MockTransport::ok(404, &json));
        let Err(GithubError::CommandFailed(message)) = response else {
            panic!("expected command failure");
        };
        for secret in [token, auth.as_str(), header.as_str(), "url-secret"] {
            assert!(!message.contains(secret), "leaked {secret:?}: {message}");
        }
        assert!(
            message.contains("https://alice:***@gitlab.com/g/r"),
            "{message}"
        );

        // Plain-text non-2xx bodies are intentionally replaced by the existing
        // generic status message; they must not gain a leak during mapping.
        let text = format!("upstream echoed {header}");
        let Err(GithubError::CommandFailed(message)) =
            client.finish("detail", MockTransport::ok(500, &text))
        else {
            panic!("expected command failure");
        };
        assert!(!message.contains(token), "{message}");
        assert!(!message.contains(&auth), "{message}");

        let transport =
            format!("request failed with {header} at https://alice:url-secret@gitlab.com");
        let Err(GithubError::Network(message)) =
            client.finish("detail", Err(HttpError::Transport(transport)))
        else {
            panic!("expected network failure");
        };
        for secret in [token, auth.as_str(), header.as_str(), "url-secret"] {
            assert!(!message.contains(secret), "leaked {secret:?}: {message}");
        }
    }

    #[test]
    fn rest_errors_redact_encoded_active_values_from_queries_and_userinfo() {
        let token = "live secret=Z";
        let encoded_token = "live+secret%3d%5A";
        let encoded_auth = "Bearer+live%20secret%3D%5a";
        let encoded_header = "Authorization%3a+Bearer%20live+secret=%5A";
        let http = MockTransport::new(vec![]);
        let client = RestClient::new(&http, "gitlab.com", token);
        let body = format!(
            r#"{{"message":"https://{encoded_token}@gitlab.com/g/r?token={encoded_token}&auth={encoded_auth}&header={encoded_header}"}}"#
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
            encoded_auth,
            encoded_header,
            "live secret%3D%5a",
        ] {
            assert!(
                !debug.contains(exposed),
                "debug leaked {exposed:?}: {debug}"
            );
            assert!(!ipc.contains(exposed), "IPC leaked {exposed:?}: {ipc}");
        }
        assert!(ipc.contains("https://***@gitlab.com/g/r"), "{ipc}");
    }

    #[test]
    fn rest_error_redaction_keeps_categories_and_ignores_an_empty_token() {
        let http = MockTransport::new(vec![]);
        let client = RestClient::new(&http, "gitlab.com", "glpat-live-secret");
        assert!(matches!(
            client.finish(
                "merge",
                MockTransport::ok(403, r#"{"message":"glpat-live-secret"}"#),
            ),
            Err(GithubError::PermissionDenied { operation: "merge" })
        ));

        let empty = RestClient::new(&http, "gitlab.com", "");
        let response = empty.finish(
            "detail",
            MockTransport::ok(404, r#"{"message":"Bearer authentication failed"}"#),
        );
        assert_eq!(
            response,
            Err(GithubError::CommandFailed(
                "Bearer authentication failed".to_string()
            ))
        );
    }
}
