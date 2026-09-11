//! Git version gate for the write-path subprocess.

use std::process::Command;

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
        if running_under_rosetta() {
            return Err(ROSETTA_GIT_UNAVAILABLE.to_string());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            format!(
                "Git is installed but its version could not be determined ({}).",
                output.status
            )
        } else {
            format!("Git is installed but its version could not be determined: {detail}")
        });
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

/// The one git failure the stderr passthrough cannot make actionable: macOS's
/// `/usr/bin/git` is a universal `xcrun` shim, so a translated (Rosetta)
/// parent makes the kernel pick its x86_64 slice, which then cannot load the
/// arm64-only `libxcrun.dylib` the Command Line Tools ship. Every git call
/// fails with a dylib-architecture dump that reads like a broken Git install
/// when the real cause is the wrong GitLane build. The in-app updater cannot
/// undo it either — Tauri derives the update target from the running process
/// architecture, so a translated app keeps updating itself to x86_64 — which
/// is why the message names the manual reinstall.
const ROSETTA_GIT_UNAVAILABLE: &str = "This is the Intel build of GitLane running under Rosetta on an Apple Silicon Mac, so macOS Git cannot start. Install the Apple Silicon (arm64) build — updating in place will not switch architecture.";

/// True only for the x86_64 build translated on Apple Silicon. Checked on the
/// error path alone, so the subprocess costs nothing in the common case.
/// `sysctl.proc_translated` does not exist on a real Intel Mac, where the
/// lookup fails and the answer is correctly "not translated".
pub(super) fn running_under_rosetta() -> bool {
    if !cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        return false;
    }
    Command::new("/usr/sbin/sysctl")
        .args(["-n", "sysctl.proc_translated"])
        .output()
        .is_ok_and(|probe| probe.status.success() && probe.stdout.starts_with(b"1"))
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
