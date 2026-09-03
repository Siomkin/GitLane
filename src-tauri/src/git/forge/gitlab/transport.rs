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

use serde::Deserialize;

use crate::git::oauth::http::HttpTransport;
use crate::git::tool_probes::TOOL_PROBES;

use super::super::bounded_output::{
    self, BoundedOutput, CaptureError, DEFAULT_STDOUT_LIMIT, DIFF_STDOUT_LIMIT, STDERR_LIMIT,
};
use super::super::domain::GithubError;
use super::super::rest;

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
            // A cached presence probe for a binary that is gone — drop it so
            // the next operation re-detects (once; no re-probe here).
            TOOL_PROBES.glab.invalidate();
            GLAB_NOT_FOUND.to_string()
        }
        CaptureError::Spawn(source) => format!("failed to launch glab: {source}"),
        other => format!("glab {other}"),
    }
}

const GLAB_NOT_FOUND: &str =
    "GitLab CLI (glab) not found on PATH. Install glab and run `glab auth login` to use merge requests. GCM/helper or SSH can still handle git transport.";

/// Whether `glab` is installed (`glab --version` succeeds). Only presence is
/// cached (`ProbeCell`, success-only — a transient spawn failure is never
/// sticky), dropped by `refresh_tool_probes` or a `NotFound` spawn error. This
/// is presence only — glab surfaces its own clear error if it is installed but
/// not authenticated for the repo's host.
pub fn glab_available() -> bool {
    TOOL_PROBES
        .glab
        .get_or_probe(|| run_glab(".", &["--version"]).map(drop))
        .is_ok()
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

/// Direct GitLab REST v4 client, a thin adapter over the shared
/// [`rest::RestClient`] (GL-361): GitLab supplies its base URL
/// (`https://{host}/api/v4`), a Bearer `Authorization` (works for both OAuth
/// access tokens and personal access tokens), and [`map_http_error`]; the
/// shared client owns the verbs, response finishing, and secret redaction.
pub struct RestClient<'a> {
    rest: rest::RestClient<'a>,
}

impl<'a> RestClient<'a> {
    pub fn new(http: &'a dyn HttpTransport, host: &str, token: &str) -> Self {
        Self {
            rest: rest::RestClient::new(
                http,
                rest::RestConfig {
                    provider: "GitLab",
                    base_url: format!("https://{host}/api/v4"),
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

impl GitlabApi for RestClient<'_> {
    fn get(&self, operation: &'static str, path: &str) -> Result<String, GithubError> {
        self.rest.get_json(operation, path)
    }

    fn get_with_limit(
        &self,
        operation: &'static str,
        path: &str,
        max_bytes: usize,
    ) -> Result<String, GithubError> {
        self.rest.get_json_with_limit(operation, path, max_bytes)
    }

    fn send(
        &self,
        operation: &'static str,
        method: Method,
        path: &str,
        form: &[(&str, &str)],
    ) -> Result<String, GithubError> {
        match method {
            Method::Post => self.rest.post_form(operation, path, form),
            Method::Put => self.rest.put_form(operation, path, form),
        }
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
mod tests;
