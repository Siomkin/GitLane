//! `gh` CLI execution and account/token discovery for the [`github`] module.
//!
//! This is the only place under `git/forge/` that constructs a `gh` subprocess
//! ([`run_gh`] owns the single `Command::new("gh")`); the PR, review-thread, and
//! diff behaviour in the parent module call through it, so transport stays in
//! one spot. [`accounts`] and [`token_for`] are re-exported by the parent as the
//! stable `git::forge::*` public API; tokens never leave the process.

use std::{collections::BTreeMap, fmt, process::Command, sync::OnceLock};

use serde::Deserialize;

use crate::git::types::{GithubAccount, GithubAccountRef};

use super::bounded_output::{
    self, BoundedOutput, CaptureError, DEFAULT_STDOUT_LIMIT, STDERR_LIMIT,
};
use super::domain::{normalize_host, GithubError, GithubRepository, GH_PROVIDER};
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

/// Run `gh <args...>` in `workdir`. When `token` is set it is exported as the
/// auth token, pinning the call to a specific account. Returns stdout on
/// success or a readable error (including the gh-not-installed case).
fn gh_command(workdir: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new("gh");
    cmd.current_dir(workdir).args(args);
    // macOS GUI apps launch with a minimal PATH that excludes Homebrew's
    // `/opt/homebrew/bin`, where `gh` typically lives. Use the augmented PATH so
    // the binary is found regardless of how the app was started.
    cmd.env("PATH", crate::shell::path());
    // gh infers repository/host context from cwd. Inherited GIT_DIR and its
    // siblings would override that directory and could route an authenticated
    // command to another repository or provider host.
    crate::git::clear_repository_local_env(&mut cmd);
    crate::shell::hide_console(&mut cmd);
    cmd
}

pub(super) fn run_gh(workdir: &str, args: &[&str], token: Option<&str>) -> Result<String, String> {
    run_gh_with_limit(workdir, args, token, DEFAULT_STDOUT_LIMIT)
}

pub(super) fn run_gh_with_limit(
    workdir: &str,
    args: &[&str],
    token: Option<&str>,
    stdout_limit: usize,
) -> Result<String, String> {
    let mut cmd = gh_command(workdir, args);
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

    let output = bounded_output::capture(&mut cmd, stdout_limit, STDERR_LIMIT)
        .map_err(map_gh_capture_error)?;

    finish_gh_output(output, token)
}

fn finish_gh_output(output: BoundedOutput, token: Option<&str>) -> Result<String, String> {
    finish_gh_bytes(
        output.status.success(),
        &output.stdout,
        &output.stderr,
        output.stderr_truncated,
        token,
    )
}

fn finish_gh_bytes(
    success: bool,
    stdout: &[u8],
    stderr: &[u8],
    stderr_truncated: bool,
    token: Option<&str>,
) -> Result<String, String> {
    if success {
        // Only stdout is returned, and it is the payload a parser consumes —
        // never rewrite it. gh puts diagnostics on stderr, which success drops.
        Ok(String::from_utf8_lossy(stdout).to_string())
    } else {
        let stdout = String::from_utf8_lossy(stdout);
        let stderr = String::from_utf8_lossy(stderr);
        let mut combined = format!("{stdout}{stderr}").trim().to_string();
        // Say so rather than passing a clipped tail off as gh's whole message.
        if stderr_truncated {
            combined.push_str(&bounded_output::stderr_truncated_notice());
        }
        // Scrub any credential a remote URL in gh's output might carry, plus the
        // token this invocation exported as GH_TOKEN. gh can echo its own
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

fn map_gh_capture_error(error: CaptureError) -> String {
    match error {
        CaptureError::Spawn(source) if source.kind() == std::io::ErrorKind::NotFound => {
            "GitHub CLI (gh) not found on PATH — install it from https://cli.github.com to use pull requests.".to_string()
        }
        CaptureError::Spawn(source) => format!("failed to launch gh: {source}"),
        other => format!("gh {other}"),
    }
}

/// Canonical `gh --repo` target derived from the already-validated service
/// context. Always include the authority so `gh` never falls back to inferring a
/// different host from the local remote (especially an SSH remote whose bare
/// transport hostname maps to an account API authority with a custom port).
pub(super) fn repo_selector(repository: &GithubRepository) -> String {
    format!(
        "{}/{}/{}",
        repository.host, repository.owner, repository.name
    )
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
fn parse_gh_version(raw: &str) -> Option<GhVersion> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn gh_commands_clear_repository_local_environment() {
        let command = gh_command(".", &["version"]);
        for key in crate::git::REPOSITORY_LOCAL_ENV_VARS {
            assert!(
                command
                    .get_envs()
                    .any(|(name, value)| name == OsStr::new(key) && value.is_none()),
                "{key} must be removed from the gh subprocess environment"
            );
        }
    }

    #[test]
    fn missing_gh_copy_is_preserved() {
        let error = map_gh_capture_error(CaptureError::Spawn(std::io::Error::from(
            std::io::ErrorKind::NotFound,
        )));
        assert_eq!(
            error,
            "GitHub CLI (gh) not found on PATH — install it from https://cli.github.com to use pull requests."
        );
    }

    #[test]
    fn bounded_finish_preserves_lossy_and_stream_order_semantics() {
        assert_eq!(
            finish_gh_bytes(true, b"ok\xff", b"ignored stderr", false, None).unwrap(),
            "ok\u{fffd}"
        );

        let error = finish_gh_bytes(
            false,
            b" stdout first\n",
            b"stderr https://alice:secret@example.test/repo\xff \n",
            false,
            None,
        )
        .unwrap_err();
        assert_eq!(
            error,
            "stdout first\nstderr https://alice:***@example.test/repo\u{fffd}"
        );
    }

    #[test]
    fn truncated_diagnostics_are_disclosed_but_never_shown_on_success() {
        // Truncation must not silently pass a clipped tail off as the whole
        // message; on success stderr is unread, so it stays invisible.
        assert_eq!(
            finish_gh_bytes(true, b"payload", b"clipped trace", true, None).unwrap(),
            "payload"
        );

        let error = finish_gh_bytes(false, b"", b"partial trace", true, None).unwrap_err();
        assert_eq!(
            error,
            format!("partial trace{}", bounded_output::stderr_truncated_notice())
        );
    }

    #[test]
    fn failures_scrub_the_token_this_invocation_exported() {
        // gh holds the same secret the REST clients scrub (GL-320), and a debug
        // trace can echo it back through stderr as a request header.
        let token = "ghp_live_secret";
        let error = finish_gh_bytes(
            false,
            b"",
            format!("GET /repos: Authorization: token {token}\nauth=ghp_live%5Fsecret").as_bytes(),
            false,
            Some(token),
        )
        .unwrap_err();
        assert!(!error.contains(token), "{error}");
        assert!(!error.contains("ghp_live%5Fsecret"), "{error}");
        assert!(error.contains("GET /repos"), "{error}");

        // Success returns the payload untouched — rewriting stdout would corrupt
        // a body the caller is about to parse.
        assert_eq!(
            finish_gh_bytes(true, token.as_bytes(), b"", false, Some(token)).unwrap(),
            token
        );
    }

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

    /// The regression: Debian/Arch and source builds carry a git-describe suffix.
    /// The old parser choked on it and reported gh as unreadable ("failed to parse
    /// gh version output"), which surfaced as a red error — even though the version
    /// is right there and merely old.
    #[test]
    fn parses_gh_version_from_a_distro_build_suffix() {
        assert_eq!(
            parse_gh_version("gh version 2.74.0-19-gea8fc856e (2025-06-09)\nhttps://github.com/cli/cli/releases/latest"),
            Some(GhVersion { major: 2, minor: 74, patch: 0 })
        );
        assert_eq!(
            parse_gh_version("gh version v2.96.1+deb1 (2026-07-02)"),
            Some(GhVersion {
                major: 2,
                minor: 96,
                patch: 1
            })
        );
    }

    #[test]
    fn a_version_banner_with_no_version_is_still_unparsable() {
        // The URL line alone must not be mistaken for a version.
        assert_eq!(
            parse_gh_version("https://github.com/cli/cli/releases/latest"),
            None
        );
        assert_eq!(parse_gh_version(""), None);
    }

    /// `gh` is optional: every "can't use gh" failure must be classified as such,
    /// so enumerating accounts degrades to "none" instead of nagging with an error.
    #[test]
    fn every_unusable_gh_failure_is_classified_as_unusable() {
        assert!(GithubError::ProviderUnavailable {
            provider: GH_PROVIDER.to_string()
        }
        .is_gh_unusable());
        assert!(GithubError::UnsupportedVersion {
            installed: "2.74.0".into(),
            required: MIN_GH_VERSION.to_string(),
        }
        .is_gh_unusable());
        assert!(GithubError::GhUnusable {
            detail: "missing capabilities".into()
        }
        .is_gh_unusable());
        // A real failure stays a real failure — it must still reach the user.
        assert!(!GithubError::NotAuthenticated {
            host: "github.com".into(),
            account: None
        }
        .is_gh_unusable());
        assert!(!GithubError::CommandFailed("boom".into()).is_gh_unusable());
    }

    #[test]
    fn repo_selector_preserves_the_validated_authority_and_slug() {
        let repository = GithubRepository {
            host: "ghe.example.test:8443".into(),
            owner: "octo".into(),
            name: "app".into(),
        };
        assert_eq!(repo_selector(&repository), "ghe.example.test:8443/octo/app");
    }
}
