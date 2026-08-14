//! Git version gate for the write-path subprocess.

use std::sync::OnceLock;

use crate::git::isolated_git_command;

const MINIMUM_GIT_VERSION: (u32, u32, u32) = (2, 36, 0);
static GIT_VERSION_CHECK: OnceLock<Result<(), String>> = OnceLock::new();

pub(super) fn ensure_supported_git() -> Result<(), String> {
    GIT_VERSION_CHECK
        .get_or_init(|| {
            let output = isolated_git_command()
                .arg("--version")
                .env("PATH", crate::shell::path())
                .output()
                .map_err(|error| format!("failed to launch git: {error}"))?;
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
        })
        .clone()
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
