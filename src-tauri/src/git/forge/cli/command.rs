use std::process::Command;

use super::super::bounded_output::{
    self, BoundedOutput, CaptureError, DEFAULT_STDOUT_LIMIT, STDERR_LIMIT,
};

/// Run `gh <args...>` in `workdir`. When `token` is set it is exported as the
/// auth token, pinning the call to a specific account. Returns stdout on
/// success or a readable error (including the gh-not-installed case).
pub(super) fn gh_command(workdir: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new("gh");
    cmd.current_dir(workdir).args(args);
    // macOS GUI apps launch with a minimal PATH that excludes Homebrew's
    // `/opt/homebrew/bin`, where `gh` typically lives. Use the augmented PATH so
    // the binary is found regardless of how the app was started.
    cmd.env("PATH", crate::shell::path());
    // gh infers repository/host context from cwd. Inherited GIT_DIR and its
    // siblings would override that directory and could route an authenticated
    // command to another repository or provider host.
    crate::git::clear_repository_local_env(&mut cmd);
    crate::shell::hide_console(&mut cmd);
    cmd
}

pub(in crate::git::forge) fn run_gh(
    workdir: &str,
    args: &[&str],
    token: Option<&str>,
) -> Result<String, String> {
    run_gh_with_limit(workdir, args, token, DEFAULT_STDOUT_LIMIT)
}

pub(in crate::git::forge) fn run_gh_with_limit(
    workdir: &str,
    args: &[&str],
    token: Option<&str>,
    stdout_limit: usize,
) -> Result<String, String> {
    let mut cmd = gh_command(workdir, args);
    if let Some(t) = token {
        // gh reads GH_TOKEN for github.com / *.ghe.com hosts and
        // GH_ENTERPRISE_TOKEN for GitHub Enterprise Server hosts, consulting only
        // the one that matches the operative host and ignoring the other. Export
        // the bound-account token under both names so the call stays pinned to
        // that account on every host; otherwise GHES requests silently fall back
        // to gh's stored credentials and run as the wrong user.
        cmd.env("GH_TOKEN", t);
        cmd.env("GH_ENTERPRISE_TOKEN", t);
    }

    let output = bounded_output::capture(&mut cmd, stdout_limit, STDERR_LIMIT)
        .map_err(map_gh_capture_error)?;

    finish_gh_output(output, token)
}

fn finish_gh_output(output: BoundedOutput, token: Option<&str>) -> Result<String, String> {
    finish_gh_bytes(
        output.status.success(),
        &output.stdout,
        &output.stderr,
        output.stderr_truncated,
        token,
    )
}

pub(super) fn finish_gh_bytes(
    success: bool,
    stdout: &[u8],
    stderr: &[u8],
    stderr_truncated: bool,
    token: Option<&str>,
) -> Result<String, String> {
    if success {
        // Only stdout is returned, and it is the payload a parser consumes —
        // never rewrite it. gh puts diagnostics on stderr, which success drops.
        Ok(String::from_utf8_lossy(stdout).to_string())
    } else {
        let stdout = String::from_utf8_lossy(stdout);
        let stderr = String::from_utf8_lossy(stderr);
        let mut combined = format!("{stdout}{stderr}").trim().to_string();
        // Say so rather than passing a clipped tail off as gh's whole message.
        if stderr_truncated {
            combined.push_str(&bounded_output::stderr_truncated_notice());
        }
        // Scrub any credential a remote URL in gh's output might carry, plus the
        // token this invocation exported as GH_TOKEN. gh can echo its own
        // request headers (`GH_DEBUG=api`), and the REST clients already scrub
        // their active credential the same way (GL-320) — the CLI holds the very
        // same secret, so it must not be the weaker boundary. An absent token is
        // the empty string, which `redact_secrets_with_values` ignores.
        Err(crate::redact::redact_secrets_with_values(
            &combined,
            &[token.unwrap_or_default()],
        ))
    }
}

pub(super) fn map_gh_capture_error(error: CaptureError) -> String {
    match error {
        CaptureError::Spawn(source) if source.kind() == std::io::ErrorKind::NotFound => {
            // The cached capability probe vouched for a binary that is gone —
            // drop it so the next operation re-detects (once; no re-probe here).
            crate::git::tool_probes::TOOL_PROBES.gh.invalidate();
            "GitHub CLI (gh) not found on PATH — install it from https://cli.github.com to use pull requests.".to_string()
        }
        CaptureError::Spawn(source) => format!("failed to launch gh: {source}"),
        other => format!("gh {other}"),
    }
}
