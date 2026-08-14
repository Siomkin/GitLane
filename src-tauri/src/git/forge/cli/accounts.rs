use std::collections::BTreeMap;

use serde::Deserialize;

use crate::git::types::{GithubAccount, GithubAccountRef};

use super::super::domain::{normalize_host, GH_PROVIDER};
use super::super::dto::GhUser;
use super::capabilities::ensure_supported;
use super::command::run_gh;

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

/// True when an error string indicates `gh` itself is missing (vs. a normal
/// non-zero exit such as "not logged in" or "no GitHub remote").
fn is_missing_gh(err: &str) -> bool {
    err.contains("gh) not found")
}

/// Resolve the auth token for a specific logged-in account. The token is held
/// only long enough for the caller to pass it to a child process environment.
pub(in crate::git::forge) fn token_for(account: &GithubAccountRef) -> Result<String, String> {
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
pub(in crate::git::forge) fn sign_out(host: &str, login: &str) -> Result<String, String> {
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
pub(in crate::git::forge) fn accounts() -> Result<Vec<GithubAccount>, String> {
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
