//! Git version gate for the write-path subprocess.

use super::command::launch_error;
use crate::git::isolated_git_command;
use crate::git::tool_probes::TOOL_PROBES;

const MINIMUM_GIT_VERSION: (u32, u32, u32) = (2, 36, 0);

/// Verify the installed git meets the minimum once, then answer from the probe
/// cache until it is invalidated (`refresh_tool_probes`, or a `NotFound` spawn
/// error). Only a pass is cached: a missing or too-old git is re-checked on the
/// next write, so upgrading it mid-session takes effect without a relaunch.
pub(super) fn ensure_supported_git() -> Result<(), String> {
    TOOL_PROBES.git.get_or_probe(probe_git_version)
}

fn probe_git_version() -> Result<(), String> {
    let output = isolated_git_command()
        .arg("--version")
        .env("PATH", crate::shell::path())
        .output()
        .map_err(launch_error)?;
    if !output.status.success() {
        return Err("Git is installed but its version could not be determined.".to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let version = parse_git_version(&text).ok_or_else(|| {
        format!(
            "Could not understand the installed Git version: {}",
            text.trim()
        )
    })?;
    if version < MINIMUM_GIT_VERSION {
        return Err(format!(
            "GitLane requires Git 2.36.0 or newer; installed version is {}.{}.{}.",
            version.0, version.1, version.2
        ));
    }
    Ok(())
}

pub(super) fn parse_git_version(output: &str) -> Option<(u32, u32, u32)> {
    let version = output.trim().strip_prefix("git version ")?;
    let mut parts = version.split(['.', ' ', '-']);
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next().and_then(|part| part.parse().ok()).unwrap_or(0),
    ))
}
