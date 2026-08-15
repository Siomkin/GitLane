//! Turn a finished git process into a non-empty `Result`.

use std::process::ExitStatus;

/// Build the surfaced error for a git process that has **already failed**,
/// guaranteeing a **non-empty** message. Some git versions fail a command
/// without writing anything to stdout/stderr — notably git 2.43 (the default on
/// Ubuntu 24.04 LTS / Debian stable) on a failed `stash push` against a locked
/// index. Returning the raw combined output there would surface an *empty*
/// error to the user, so fall back to the exit status when there's nothing else
/// to show.
pub(in crate::git::write) fn failure_message(
    status: ExitStatus,
    stdout: &str,
    stderr: &str,
    args: &[&str],
) -> String {
    let combined = format!("{stdout}{stderr}").trim().to_string();
    if combined.is_empty() {
        let how = status
            .code()
            .map(|c| format!("exit code {c}"))
            .unwrap_or_else(|| "a signal".to_string());
        // Name only the first couple of args, never the full argv. The second
        // argument can itself be a URL-valued push remote, so scrub this fallback
        // just like real stderr before it crosses IPC.
        let op = args.iter().take(2).copied().collect::<Vec<_>>().join(" ");
        crate::redact::redact_secrets(&format!("git {op} failed ({how})"))
    } else {
        // Errors cross IPC directly. Scrub any credential git echoed before it
        // reaches a toast/log, while preserving successful machine output for
        // internal parsers (diffs, stash lists, porcelain status, and so on).
        crate::redact::redact_secrets(&combined)
    }
}

/// Turn a finished git process into a `Result`: trimmed combined output on
/// success, [`failure_message`] otherwise.
pub(in crate::git::write) fn finish(
    status: ExitStatus,
    stdout: &str,
    stderr: &str,
    args: &[&str],
) -> Result<String, String> {
    if status.success() {
        Ok(format!("{stdout}{stderr}").trim().to_string())
    } else {
        Err(failure_message(status, stdout, stderr, args))
    }
}
