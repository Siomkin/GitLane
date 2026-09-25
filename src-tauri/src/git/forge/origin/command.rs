use std::process::Command;

use super::super::bounded_output::{self, DEFAULT_STDOUT_LIMIT, STDERR_LIMIT};
use crate::git::tool_probes::TOOL_PROBES;

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
    let output =
        bounded_output::capture(&mut cmd, stdout_limit, STDERR_LIMIT).map_err(|error| {
            bounded_output::map_capture_error(
                error,
                "origin",
                ORIGIN_NOT_FOUND,
                &TOOL_PROBES.origin,
            )
        })?;
    bounded_output::finish(output, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_found_mentions_origin_not_gh() {
        assert!(ORIGIN_NOT_FOUND.contains("Origin CLI"));
        assert!(ORIGIN_NOT_FOUND.contains(ORIGIN_INSTALL_URL));
        assert!(!ORIGIN_NOT_FOUND.to_ascii_lowercase().contains("github cli"));
    }
}
