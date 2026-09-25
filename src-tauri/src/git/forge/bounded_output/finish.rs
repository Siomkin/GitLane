//! Turning a captured provider-CLI run into the `Result` the transports
//! return — shared by `gh`, `glab`, and `origin`, which differ only in the
//! tool name, their not-found copy, and whether they export a token.

use super::{stderr_truncated_notice, BoundedOutput, CaptureError};
use crate::git::tool_probes::ProbeCell;

pub(in crate::git::forge) fn finish(
    output: BoundedOutput,
    token: Option<&str>,
) -> Result<String, String> {
    finish_bytes(
        output.status.success(),
        &output.stdout,
        &output.stderr,
        output.stderr_truncated,
        token,
    )
}

pub(in crate::git::forge) fn finish_bytes(
    success: bool,
    stdout: &[u8],
    stderr: &[u8],
    stderr_truncated: bool,
    token: Option<&str>,
) -> Result<String, String> {
    if success {
        // Only stdout is returned, and it is the payload a parser consumes —
        // never rewrite it. The CLIs put diagnostics on stderr, which success
        // drops.
        Ok(String::from_utf8_lossy(stdout).to_string())
    } else {
        let stdout = String::from_utf8_lossy(stdout);
        let stderr = String::from_utf8_lossy(stderr);
        let mut combined = format!("{stdout}{stderr}").trim().to_string();
        // Say so rather than passing a clipped tail off as the whole message.
        if stderr_truncated {
            combined.push_str(&stderr_truncated_notice());
        }
        // Scrub any credential a remote URL in the output might carry, plus the
        // token this invocation exported (gh's GH_TOKEN). gh can echo its own
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

/// Map a capture failure to the user-facing message. A `NotFound` spawn means
/// the cached probe vouched for a binary that is gone — drop it so the next
/// operation re-detects (once; no re-probe here).
pub(in crate::git::forge) fn map_capture_error<T: Clone>(
    error: CaptureError,
    tool: &str,
    not_found: &str,
    probe: &ProbeCell<T>,
) -> String {
    match error {
        CaptureError::Spawn(source) if source.kind() == std::io::ErrorKind::NotFound => {
            probe.invalidate();
            not_found.to_string()
        }
        CaptureError::Spawn(source) => format!("failed to launch {tool}: {source}"),
        other => format!("{tool} {other}"),
    }
}
