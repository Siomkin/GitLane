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

use crate::git::oauth::http::{HttpError, HttpResult, HttpTransport};

use super::super::domain::GithubError;

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
pub fn run_glab(workdir: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("glab");
    cmd.current_dir(workdir).args(args);
    cmd.env("PATH", crate::shell::path());
    crate::shell::hide_console(&mut cmd);

    let output = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            GLAB_NOT_FOUND.to_string()
        } else {
            format!("failed to launch glab: {e}")
        }
    })?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(crate::redact::redact_secrets(
            format!("{stdout}{stderr}").trim(),
        ))
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
}

impl GitlabApi for GlabCli {
    fn get(&self, operation: &'static str, path: &str) -> Result<String, GithubError> {
        self.run(operation, &["api", path])
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

    fn finish(&self, operation: &'static str, result: HttpResult) -> Result<String, GithubError> {
        match result {
            Ok(resp) if resp.is_success() => Ok(resp.body),
            Ok(resp) => Err(map_http_error(operation, &self.host, resp.status, &resp.body)),
            Err(HttpError::ResponseTooLarge { limit }) => Err(GithubError::InvalidResponse(
                format!(
                    "GitLab {operation} exceeded the {limit}-byte response limit; the partial response was discarded."
                ),
            )),
            // A transport failure message may quote the request URL (never a
            // secret — the token rides in a header), but redact defensively.
            Err(HttpError::Transport(err)) => {
                Err(GithubError::Network(crate::redact::redact_secrets(&err)))
            }
        }
    }
}

impl GitlabApi for RestClient<'_> {
    fn get(&self, operation: &'static str, path: &str) -> Result<String, GithubError> {
        let auth = self.auth_header();
        let headers = [("Authorization", auth.as_str()), ("Accept", "application/json")];
        self.finish(operation, self.http.get(&self.url(path), &headers))
    }

    fn send(
        &self,
        operation: &'static str,
        method: Method,
        path: &str,
        form: &[(&str, &str)],
    ) -> Result<String, GithubError> {
        let auth = self.auth_header();
        let headers = [("Authorization", auth.as_str()), ("Accept", "application/json")];
        let url = self.url(path);
        let result = match method {
            Method::Post => self.http.post_form(&url, form, &headers),
            Method::Put => self.http.put_form(&url, form, &headers),
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
        match map_http_error("detail", "gitlab.com", 404, r#"{"message":"404 Not found"}"#) {
            GithubError::CommandFailed(msg) => assert!(msg.contains("Not found")),
            other => panic!("expected CommandFailed, got {other:?}"),
        }
    }
}
