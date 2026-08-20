use std::process::Command;

use super::super::bounded_output::{
    self, BoundedOutput, CaptureError, DEFAULT_STDOUT_LIMIT, STDERR_LIMIT,
};

pub(super) const ORIGIN_INSTALL_URL: &str = "https://cursor.com/docs/origin/cli";
pub(super) const ORIGIN_NOT_FOUND: &str =
    "Origin CLI (origin) not found on PATH — install it from https://cursor.com/docs/origin/cli to use Cursor Origin pull requests.";

fn origin_command(workdir: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new("origin");
    cmd.current_dir(workdir).args(args);
    cmd.env("PATH", crate::shell::path());
    cmd.env("NO_COLOR", "1");
    crate::git::clear_repository_local_env(&mut cmd);
    crate::shell::hide_console(&mut cmd);
    cmd
}

pub(super) fn run_origin(workdir: &str, args: &[&str]) -> Result<String, String> {
    run_origin_with_limit(workdir, args, DEFAULT_STDOUT_LIMIT)
}

pub(super) fn run_origin_with_limit(
    workdir: &str,
    args: &[&str],
    stdout_limit: usize,
) -> Result<String, String> {
    let mut cmd = origin_command(workdir, args);
    let output = bounded_output::capture(&mut cmd, stdout_limit, STDERR_LIMIT)
        .map_err(map_origin_capture_error)?;
    finish_origin_output(output)
}

fn finish_origin_output(output: BoundedOutput) -> Result<String, String> {
    finish_origin_bytes(
        output.status.success(),
        &output.stdout,
        &output.stderr,
        output.stderr_truncated,
    )
}

pub(super) fn finish_origin_bytes(
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
        if stderr_truncated {
            combined.push_str(&bounded_output::stderr_truncated_notice());
        }
        Err(crate::redact::redact_secrets(&combined))
    }
}

pub(super) fn map_origin_capture_error(error: CaptureError) -> String {
    match error {
        CaptureError::Spawn(source) if source.kind() == std::io::ErrorKind::NotFound => {
            ORIGIN_NOT_FOUND.to_string()
        }
        CaptureError::Spawn(source) => format!("failed to launch origin: {source}"),
        other => format!("origin {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_tokens_from_failed_output() {
        let err = finish_origin_bytes(
            false,
            b"",
            b"Authentication failed for 'https://user:supersecret@origin.cursor.com/acme/app.git'",
            false,
        )
        .unwrap_err();
        assert!(!err.contains("supersecret"), "{err}");
        assert!(
            err.contains("https://user:***@origin.cursor.com/acme/app.git"),
            "{err}"
        );
    }

    #[test]
    fn not_found_mentions_origin_not_gh() {
        let err = map_origin_capture_error(CaptureError::Spawn(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "nope",
        )));
        assert!(err.contains("Origin CLI"));
        assert!(err.contains(ORIGIN_INSTALL_URL));
        assert!(!err.to_ascii_lowercase().contains("github cli"));
    }
}
