use super::super::bounded_output::CliError;
use super::super::domain::GithubError;
use super::command::{run_origin, ORIGIN_INSTALL_URL};
use crate::git::tool_probes::TOOL_PROBES;

/// The detected `origin` baseline. `pub(crate)` only so the process-wide probe
/// cache (`git::tool_probes`) can hold it; detection stays here.
#[derive(Debug, Clone)]
pub(crate) struct OriginCapabilities {
    pub(super) pr_diff_patch: bool,
    pub(super) api: bool,
    pub(super) pr_thread: bool,
}

pub(super) fn ensure_supported() -> Result<OriginCapabilities, GithubError> {
    if cfg!(windows) {
        return Err(GithubError::CommandFailed(
            "The Origin CLI is not supported on native Windows. Cursor Origin pull requests need macOS, Linux, or WSL. See https://cursor.com/docs/origin/cli.".to_string(),
        ));
    }
    // Success-only cache, dropped by `refresh_tool_probes` or a `NotFound`
    // spawn error — see `git::tool_probes`.
    let caps = TOOL_PROBES.origin.get_or_probe(detect_capabilities)?;
    if !caps.pr_diff_patch || !caps.api || !caps.pr_thread {
        return Err(GithubError::CommandFailed(format!(
            "Origin CLI is missing capabilities GitLane needs (pr diff --patch, api, pr thread). Update it from {ORIGIN_INSTALL_URL}."
        )));
    }
    Ok(caps)
}

fn detect_capabilities() -> Result<OriginCapabilities, GithubError> {
    let _version = run_origin(".", &["--version"]).map_err(map_probe_error)?;
    let pr_diff_help = run_origin(".", &["pr", "diff", "--help"]).map_err(map_probe_error)?;
    let api_help = run_origin(".", &["api", "--help"]).map_err(map_probe_error)?;
    let thread_help = run_origin(".", &["pr", "thread", "--help"]).map_err(map_probe_error)?;
    Ok(OriginCapabilities {
        pr_diff_patch: pr_diff_help.contains("--patch"),
        api: !api_help.is_empty(),
        // Only the subcommands GitLane actually invokes. `reply` is deliberately
        // absent: in-app replies were removed, so requiring it would fail every
        // Origin PR read on a CLI that no longer ships it.
        pr_thread: thread_help.contains("list")
            && thread_help.contains("resolve")
            && thread_help.contains("reopen"),
    })
}

/// `run_origin` already reports a missing binary as its `ORIGIN_NOT_FOUND`, so a
/// probe failure is the CLI's message as-is.
fn map_probe_error(err: CliError) -> GithubError {
    GithubError::CommandFailed(String::from(err))
}
