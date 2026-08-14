use std::{fmt, sync::OnceLock};

use super::super::domain::GithubError;
use super::command::run_gh;

pub(super) const MIN_GH_VERSION: GhVersion = GhVersion {
    major: 2,
    minor: 95,
    patch: 0,
};
// Only *successful* capability detection is cached; a transient failure (gh
// briefly unavailable) must not be sticky for the process lifetime.
static GH_CAPABILITIES: OnceLock<GhCapabilities> = OnceLock::new();

#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(in crate::git::forge) struct GhVersion {
    pub(super) major: u64,
    pub(super) minor: u64,
    pub(super) patch: u64,
}

impl fmt::Display for GhVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[derive(Debug, Clone)]
pub(in crate::git::forge) struct GhCapabilities {
    pub(super) version: GhVersion,
    pub(super) auth_status_json: bool,
    pub(super) auth_token_host_user: bool,
    pub(super) pr_diff_patch: bool,
    pub(super) graphql: bool,
}

pub(in crate::git::forge) fn ensure_supported() -> Result<GhCapabilities, GithubError> {
    let caps = match GH_CAPABILITIES.get() {
        Some(caps) => caps.clone(),
        None => {
            // Propagate a detection error WITHOUT caching it, so the next call
            // retries; cache only on success (best-effort under a race).
            let detected = detect_capabilities()?;
            let _ = GH_CAPABILITIES.set(detected.clone());
            detected
        }
    };
    if caps.version < MIN_GH_VERSION {
        return Err(GithubError::UnsupportedVersion {
            installed: caps.version.to_string(),
            required: MIN_GH_VERSION.to_string(),
        });
    }
    if !caps.auth_status_json || !caps.auth_token_host_user || !caps.pr_diff_patch || !caps.graphql
    {
        return Err(GithubError::GhUnusable {
            detail: format!(
                "GitHub CLI {version} is missing capabilities required by GitLane. Upgrade from https://cli.github.com.",
                version = caps.version
            ),
        });
    }
    Ok(caps)
}

fn detect_capabilities() -> Result<GhCapabilities, GithubError> {
    let version_raw = run_gh(".", &["version"], None)
        .map_err(|err| GithubError::from_command("gh version", err))?;
    let version = parse_gh_version(&version_raw).ok_or_else(|| GithubError::GhUnusable {
        detail: format!(
            "Could not read the GitHub CLI version from: {}",
            version_raw.lines().next().unwrap_or("").trim()
        ),
    })?;
    let auth_status_help = run_gh(".", &["auth", "status", "--help"], None)
        .map_err(|err| GithubError::from_command("gh auth status help", err))?;
    let auth_token_help = run_gh(".", &["auth", "token", "--help"], None)
        .map_err(|err| GithubError::from_command("gh auth token help", err))?;
    let pr_diff_help = run_gh(".", &["pr", "diff", "--help"], None)
        .map_err(|err| GithubError::from_command("gh pr diff help", err))?;
    let api_help = run_gh(".", &["api", "--help"], None)
        .map_err(|err| GithubError::from_command("gh api help", err))?;

    Ok(GhCapabilities {
        version,
        auth_status_json: auth_status_help.contains("--json fields")
            && auth_status_help.contains("hosts"),
        auth_token_host_user: auth_token_help.contains("--hostname")
            && auth_token_help.contains("--user"),
        pr_diff_patch: pr_diff_help.contains("--patch") && pr_diff_help.contains("--color"),
        graphql: api_help.contains("graphql"),
    })
}

/// Pull `major.minor.patch` out of gh's version banner.
///
/// Distro and source builds append a git-describe suffix — Debian/Arch ship
/// `gh version 2.74.0-19-gea8fc856e (2025-06-09)`. The old parser trimmed
/// non-digit/dot characters from both *ends* of each token, which left
/// `2.74.0-19-gea8fc856` and then failed to parse `0-19-gea8fc856` as the patch;
/// with no token left to try it reported "failed to parse gh version output" and
/// gh looked broken rather than merely old. Take the leading numeric run instead,
/// so any suffix (`-19-g…`, `-rc1`, `+hash`) is simply ignored.
pub(super) fn parse_gh_version(raw: &str) -> Option<GhVersion> {
    raw.split_whitespace().find_map(|part| {
        let head: String = part
            .trim_start_matches('v')
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        let mut pieces = head.split('.');
        let major = pieces.next()?.parse().ok()?;
        let minor = pieces.next()?.parse().ok()?;
        let patch = pieces.next()?.parse().ok()?;
        Some(GhVersion {
            major,
            minor,
            patch,
        })
    })
}
