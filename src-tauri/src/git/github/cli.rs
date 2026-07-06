//! `gh` CLI execution and account/token discovery for the [`github`] module.
//!
//! This is the only place under `git/github/` that constructs a `gh` subprocess
//! ([`run_gh`] owns the single `Command::new("gh")`); the PR, review-thread, and
//! diff behaviour in the parent module call through it, so transport stays in
//! one spot. [`accounts`] and [`token_for`] are re-exported by the parent as the
//! stable `git::github::*` public API; tokens never leave the process.

use std::{collections::BTreeMap, fmt, process::Command, sync::OnceLock};

use serde::Deserialize;

use crate::git::types::{GithubAccount, GithubAccountRef};

use super::domain::{
    normalize_host, GithubError, GithubRepository, DEFAULT_GITHUB_HOST, GH_PROVIDER,
};
use super::dto::GhUser;

const MIN_GH_VERSION: GhVersion = GhVersion {
    major: 2,
    minor: 95,
    patch: 0,
};
// Only *successful* capability detection is cached; a transient failure (gh
// briefly unavailable) must not be sticky for the process lifetime.
static GH_CAPABILITIES: OnceLock<GhCapabilities> = OnceLock::new();

#[derive(Debug, Copy, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct GhVersion {
    major: u64,
    minor: u64,
    patch: u64,
}

impl fmt::Display for GhVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[derive(Debug, Clone)]
pub(super) struct GhCapabilities {
    pub(super) version: GhVersion,
    pub(super) auth_status_json: bool,
    pub(super) auth_token_host_user: bool,
    pub(super) pr_diff_patch: bool,
    pub(super) graphql: bool,
}

#[derive(Deserialize)]
struct GhAuthStatus {
    #[serde(default)]
    hosts: BTreeMap<String, Vec<GhAuthAccountStatus>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhAuthAccountStatus {
    #[serde(default)]
    active: bool,
    #[serde(default)]
    host: String,
    #[serde(default)]
    login: String,
    /// Per-account credential check result: "success" | "error" | "timeout".
    /// The command exits 0 even when an account's token is revoked, so this
    /// field is the only signal that the account is broken.
    #[serde(default)]
    state: String,
    /// Human-readable failure detail accompanying a non-success `state`.
    #[serde(default)]
    error: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhRepoView {
    name_with_owner: String,
    url: String,
}

/// Run `gh <args...>` in `workdir`. When `token` is set it is exported as the
/// auth token, pinning the call to a specific account. Returns stdout on
/// success or a readable error (including the gh-not-installed case).
pub(super) fn run_gh(workdir: &str, args: &[&str], token: Option<&str>) -> Result<String, String> {
    let mut cmd = Command::new("gh");
    cmd.current_dir(workdir).args(args);
    // macOS GUI apps launch with a minimal PATH that excludes Homebrew's
    // `/opt/homebrew/bin`, where `gh` typically lives. Use the augmented PATH so
    // the binary is found regardless of how the app was started.
    cmd.env("PATH", crate::shell::path());
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
    crate::shell::hide_console(&mut cmd);

    let output = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "GitHub CLI (gh) not found on PATH — install it from https://cli.github.com to use pull requests.".to_string()
        } else {
            format!("failed to launch gh: {e}")
        }
    })?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("{stdout}{stderr}").trim().to_string())
    }
}

/// True when an error string indicates `gh` itself is missing (vs. a normal
/// non-zero exit such as "not logged in" or "no GitHub remote").
fn is_missing_gh(err: &str) -> bool {
    err.contains("gh) not found")
}

pub(super) fn ensure_supported() -> Result<GhCapabilities, GithubError> {
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
        return Err(GithubError::CommandFailed(format!(
            "GitHub CLI {version} is missing capabilities required by GitLane. Upgrade from https://cli.github.com.",
            version = caps.version
        )));
    }
    Ok(caps)
}

fn detect_capabilities() -> Result<GhCapabilities, GithubError> {
    let version_raw = run_gh(".", &["version"], None)
        .map_err(|err| GithubError::from_command("gh version", err))?;
    let version = parse_gh_version(&version_raw).ok_or_else(|| {
        GithubError::InvalidResponse(format!("failed to parse gh version output: {version_raw}"))
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

fn parse_gh_version(raw: &str) -> Option<GhVersion> {
    raw.split_whitespace().find_map(|part| {
        let cleaned = part.trim_matches(|c: char| !c.is_ascii_digit() && c != '.');
        let mut pieces = cleaned.split('.');
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

/// Resolve the auth token for a specific logged-in account. The token is held
/// only long enough for the caller to pass it to a child process environment.
pub(super) fn token_for(account: &GithubAccountRef) -> Result<String, String> {
    ensure_supported().map_err(|err| err.to_ipc_string())?;
    let host = normalize_host(&account.host);
    let login = account.login.trim();
    if host.is_empty() || login.is_empty() {
        return Err("GitHub account binding is incomplete; choose the account again.".to_string());
    }
    run_gh(
        ".",
        &["auth", "token", "--hostname", &host, "--user", login],
        None,
    )
    .map(|s| s.trim().to_string())
    .and_then(|s| {
        if s.is_empty() {
            Err(format!(
                "No GitHub auth token found for @{login} on {host}."
            ))
        } else {
            Ok(s)
        }
    })
}

/// Sign a specific account out of `gh` (`gh auth logout --hostname --user`) —
/// the credential store entry is removed by `gh` itself; nothing else to clean
/// up on our side (per-repo bindings resolve to null and show as "system git
/// credentials" once the account list refreshes).
pub(super) fn sign_out(host: &str, login: &str) -> Result<String, String> {
    ensure_supported().map_err(|err| err.to_ipc_string())?;
    let host = normalize_host(host);
    let login = login.trim();
    if host.is_empty() || login.is_empty() {
        return Err("GitHub account reference is incomplete.".to_string());
    }
    run_gh(
        ".",
        &["auth", "logout", "--hostname", &host, "--user", login],
        None,
    )
}

/// Fetch the authenticated user behind `token` via `gh api user`.
fn user_info(host: &str, token: &str) -> Option<GhUser> {
    let raw = run_gh(".", &["api", "--hostname", host, "user"], Some(token)).ok()?;
    serde_json::from_str::<GhUser>(&raw).ok()
}

/// List the GitHub accounts `gh` is logged into, preserving host identity.
pub(super) fn accounts() -> Result<Vec<GithubAccount>, String> {
    ensure_supported().map_err(|err| err.to_ipc_string())?;
    let raw = match run_gh(".", &["auth", "status", "--json", "hosts"], None) {
        Ok(s) => s,
        Err(e) if is_missing_gh(&e) => return Err(e),
        Err(_) => return Ok(Vec::new()),
    };
    let parsed: GhAuthStatus = serde_json::from_str(&raw)
        .map_err(|e| format!("failed to parse gh auth status output: {e}"))?;
    let mut accounts = Vec::new();
    for (host_key, entries) in parsed.hosts {
        for entry in entries {
            let host = normalize_host(if entry.host.is_empty() {
                &host_key
            } else {
                &entry.host
            });
            let login = entry.login.trim().to_string();
            if host.is_empty() || login.is_empty() {
                continue;
            }
            // An empty state (older gh without the per-account check) counts as
            // healthy — only an explicit non-success verdict flags the account.
            let healthy = entry.state.is_empty() || entry.state == "success";
            let health_error = if healthy {
                String::new()
            } else {
                let detail = entry.error.trim();
                if detail.is_empty() {
                    format!("gh auth check reported \"{}\"", entry.state)
                } else {
                    detail.to_string()
                }
            };
            let account_ref = GithubAccountRef {
                provider: GH_PROVIDER.to_string(),
                host: host.clone(),
                account_id: login.clone(),
                login: login.clone(),
            };
            // Don't probe the API for an account gh already reported broken —
            // the call would just fail (or hang again after a timeout).
            let info = if healthy {
                token_for(&account_ref)
                    .ok()
                    .and_then(|t| user_info(&host, &t))
            } else {
                None
            };
            let account_id = info
                .as_ref()
                .map(|u| u.id.to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| login.clone());
            let (name, email, id) = match info {
                Some(u) => {
                    let name = u
                        .name
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| u.login.clone());
                    let email = u.email.filter(|s| !s.is_empty()).unwrap_or_else(|| {
                        format!("{}+{}@users.noreply.github.com", u.id, u.login)
                    });
                    (name, email, u.id)
                }
                None => (login.clone(), String::new(), 0),
            };
            accounts.push(GithubAccount {
                provider: GH_PROVIDER.to_string(),
                host,
                account_id,
                login: login.clone(),
                username: login,
                name,
                email,
                id,
                active: entry.active,
                healthy,
                health_error,
            });
        }
    }
    Ok(accounts)
}

/// Resolve the provider-neutral GitHub repository identity for `workdir`.
pub(super) fn repo_identity(
    workdir: &str,
    token: Option<&str>,
) -> Result<GithubRepository, String> {
    ensure_supported().map_err(|err| err.to_ipc_string())?;
    let raw = run_gh(
        workdir,
        &["repo", "view", "--json", "nameWithOwner,url"],
        token,
    )?;
    let parsed: GhRepoView = serde_json::from_str(&raw)
        .map_err(|e| format!("failed to parse gh repo view output: {e}"))?;
    let (owner, name) = parsed
        .name_with_owner
        .split_once('/')
        .map(|(o, n)| (o.to_string(), n.to_string()))
        .ok_or_else(|| format!("unexpected repo slug from gh: {}", parsed.name_with_owner))?;
    let host = host_from_repo_url(&parsed.url).unwrap_or_else(|| DEFAULT_GITHUB_HOST.to_string());
    Ok(GithubRepository { host, owner, name })
}

/// Resolve the `owner/name` slug for GraphQL calls.
pub(super) fn repo_slug(workdir: &str, token: Option<&str>) -> Result<(String, String), String> {
    let repo = repo_identity(workdir, token)?;
    Ok((repo.owner, repo.name))
}

fn host_from_repo_url(url: &str) -> Option<String> {
    if let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    {
        return rest
            .split('/')
            .next()
            .map(normalize_host)
            .filter(|s| !s.is_empty());
    }
    if let Some(rest) = url.strip_prefix("git@") {
        return rest
            .split(':')
            .next()
            .map(normalize_host)
            .filter(|s| !s.is_empty());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gh_version_from_standard_output() {
        assert_eq!(
            parse_gh_version("gh version 2.95.0 (2026-06-17)"),
            Some(GhVersion {
                major: 2,
                minor: 95,
                patch: 0
            })
        );
        assert_eq!(
            parse_gh_version("gh version 2.100.3-dev"),
            Some(GhVersion {
                major: 2,
                minor: 100,
                patch: 3
            })
        );
    }

    #[test]
    fn extracts_hosts_from_repo_urls() {
        assert_eq!(
            host_from_repo_url("https://github.com/owner/repo"),
            Some("github.com".into())
        );
        assert_eq!(
            host_from_repo_url("git@github.example.com:owner/repo.git"),
            Some("github.example.com".into())
        );
    }
}
