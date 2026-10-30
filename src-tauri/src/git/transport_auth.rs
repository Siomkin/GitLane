//! Provider-neutral git transport auth for real-`git` network operations.
//!
//! Transport auth refs never carry tokens. For HTTPS remotes the selected
//! identity is represented by the URL username, which Git passes to credential
//! helpers (`gitcredentials(7)`). GitHub injects a helper inline: because
//! `gh auth git-credential` answers only for gh's active account (it ignores the
//! URL username), the helper resolves the bound login's token
//! (`gh auth token --user`) and pins it for that one `gh` child, never in git's
//! own environment. Providers whose token GitLane owns itself use the
//! keychain-backed [`credential_bridge`](super::credential_bridge) via
//! `GIT_ASKPASS` (`providerToken` mode); every other remote is handled by the
//! user's configured helper / Git Credential Manager.
//!
//! Resolution yields a [`TransportCredential`] — the *strategy* for one git
//! network invocation. It still carries no secret: the `ProviderToken` variant
//! holds only a non-secret keychain locator. The parent resolves that locator,
//! then exposes the token to its askpass child through a command-scoped broker.

use crate::git::forge::ForgeKind;
use crate::git::types::GitTransportAuthRef;

use super::forge;

pub use super::forge::RemoteTransportDirection;

/// Set once by the remote agent (remote-ssh-repos): a remote with no GitLane
/// account ref then uses the server's own logged-in `gh` account for its host,
/// as a bound account does locally. Off in the desktop app.
static SERVER_GH: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Let remotes without an account ref use this machine's own `gh` login.
#[cfg(any(feature = "agent", test))]
pub fn use_server_gh() {
    SERVER_GH.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// How one git network invocation should obtain HTTPS credentials. Carries no
/// secret material — see the module docs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportCredential {
    /// No inline handling: SSH, or the user's own credential helper / GCM.
    None,
    /// Use the user's configured helper, optionally with path-aware matching.
    CredentialHelper { host: String, use_http_path: bool },
    /// GitHub `gh` credential helper scoped to `host` (the remote's credential
    /// authority). `gh auth git-credential` answers only for gh's *active*
    /// account, whatever username git asks about, so the helper first resolves
    /// `login`'s token on `gh_host` (the account's gh hostname) and pins it.
    /// Both are validated before they reach the helper's shell string.
    Gh {
        host: String,
        gh_host: String,
        login: String,
    },
    /// GitLab `glab` credential helper for `host`: glab is signed in and answers
    /// git's credential prompt from its own token store. Mirrors `Gh` for GitLab
    /// remotes so a glab sign-in provides transport with zero config (GL-139).
    Glab { host: String },
    /// A GitLane-owned provider token, fed to git through the parent-owned
    /// `GIT_ASKPASS` bridge after it is read from the OS keychain. Fields are
    /// all non-secret locators.
    ProviderToken(ProviderTokenBridge),
}

/// Non-secret locator for a keychain-backed provider token feed. `credential_host`
/// scopes the answer to one authority; `provider` + `account_id` locate the
/// keychain entry; `username` is what git is answered with (and what appears in
/// the remote URL).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderTokenBridge {
    pub credential_host: String,
    pub username: String,
    pub provider: String,
    pub account_id: String,
}

/// The credential for `remote` in `direction`. A remote that does not exist or
/// has no URL for that direction gets [`TransportCredential::None`]: there is
/// no authority to bind an account to, and git reports the remote problem in
/// its own words (and `fetch` simply skips such a bound remote).
pub fn credential_for_remote(
    workdir: &str,
    remote: &str,
    direction: RemoteTransportDirection,
    auth: Option<&GitTransportAuthRef>,
) -> Result<TransportCredential, String> {
    let Some(auth) = auth else {
        return Ok(server_gh_credential(workdir, remote, direction));
    };
    let Some(remote_host) = forge::remote_credential_host_for(workdir, remote, direction) else {
        return Ok(TransportCredential::None);
    };
    credential_for_credential_host(&remote_host, auth)
        .map_err(|err| {
            if err.contains("selected account") {
                err.replace("this remote", &format!("remote '{remote}'"))
            } else {
                err
            }
        })
        .and_then(require_supported_gh)
}

/// The server's active, healthy `gh` account for `remote`'s host, when
/// [`use_server_gh`] is on; otherwise, or on any lookup failure, `None` so
/// git's own helpers apply.
fn server_gh_credential(
    workdir: &str,
    remote: &str,
    direction: RemoteTransportDirection,
) -> TransportCredential {
    if !SERVER_GH.load(std::sync::atomic::Ordering::Relaxed) {
        return TransportCredential::None;
    }
    let Some(remote_host) = forge::remote_credential_host_for(workdir, remote, direction) else {
        return TransportCredential::None;
    };
    let Ok(accounts) = forge::accounts() else {
        return TransportCredential::None;
    };
    pick_server_gh(&accounts, &remote_host)
        .and_then(|cred| require_supported_gh(cred).ok())
        .unwrap_or(TransportCredential::None)
}

/// The `gh` helper for `remote_host` from the account `gh` treats as active
/// there, when it is healthy and its login is safe to interpolate.
fn pick_server_gh(
    accounts: &[crate::git::types::GithubAccount],
    remote_host: &str,
) -> Option<TransportCredential> {
    let actual = normalize_credential_host(remote_host);
    let account = accounts
        .iter()
        .find(|a| a.active && a.healthy && normalize_credential_host(&a.host) == actual)?;
    validate_gh_login(&account.login).ok()?;
    Some(TransportCredential::Gh {
        host: remote_host.to_string(),
        gh_host: forge::host_without_scheme(&account.host),
        login: account.login.trim().to_string(),
    })
}

pub fn credential_for_url(
    url: &str,
    auth: Option<&GitTransportAuthRef>,
) -> Result<TransportCredential, String> {
    let Some(auth) = auth else {
        return Ok(TransportCredential::None);
    };
    let Some(url_host) = forge::credential_host_for_url(url) else {
        return Ok(TransportCredential::None);
    };
    credential_for_credential_host(&url_host, auth).and_then(require_supported_gh)
}

/// The `Gh` helper needs `gh auth token --user` (GitLane's gh baseline): refuse
/// an unsupported gh here, with its upgrade message, instead of letting the
/// helper exit 1 and git report a misleading authentication failure. Kept out
/// of [`credential_for_credential_host`] so that pure resolution never spawns gh.
fn require_supported_gh(cred: TransportCredential) -> Result<TransportCredential, String> {
    if matches!(cred, TransportCredential::Gh { .. }) {
        forge::ensure_gh_supported()?;
    }
    Ok(cred)
}

fn credential_for_credential_host(
    actual_credential_host: &str,
    auth: &GitTransportAuthRef,
) -> Result<TransportCredential, String> {
    match auth {
        GitTransportAuthRef::System { .. } | GitTransportAuthRef::Ssh { .. } => {
            return Ok(TransportCredential::None);
        }
        GitTransportAuthRef::GithubGh { .. }
        | GitTransportAuthRef::GitlabGlab { .. }
        | GitTransportAuthRef::ProviderToken { .. }
        | GitTransportAuthRef::CredentialHelper { .. } => {}
    }

    let credential_host = auth.credential_host().to_string();
    let credential_host = credential_host.as_str();
    validate_credential_authority(actual_credential_host)?;
    validate_credential_authority(credential_host)?;
    let expected = normalize_credential_host(credential_host);
    let actual = normalize_credential_host(actual_credential_host);
    if !expected.is_empty() && expected != actual {
        return Err(format!(
            "The selected account is for {}, but this remote uses {}.",
            credential_host, actual_credential_host
        ));
    }

    match auth {
        GitTransportAuthRef::GithubGh { account_ref, .. } => {
            let account = account_ref;
            if account.provider != "gh" {
                return Err(format!(
                    "GitHub provider '{}' is not available for git transport auth.",
                    account.provider
                ));
            }
            // The account host and login are interpolated into the gh helper's
            // shell string: the authority charset and `validate_gh_login` keep
            // quotes, `$`, `;` and whitespace out of both.
            validate_credential_authority(&account.host)?;
            validate_gh_login(&account.login)?;
            let account_host = normalize_credential_host(&account.host);
            if account_host != actual {
                return Err(format!(
                    "The selected account signs in to {}, but this remote uses {}.",
                    account.host, actual_credential_host
                ));
            }
            Ok(TransportCredential::Gh {
                host: actual_credential_host.to_string(),
                gh_host: forge::host_without_scheme(&account.host),
                login: account.login.trim().to_string(),
            })
        }
        GitTransportAuthRef::GitlabGlab { provider, .. } => {
            // glab is single-account per host and answers for whatever it is
            // signed into, so there is no account ref to match — but the mode is
            // GitLab-only, so refuse to inject glab's helper for any other
            // provider's remote.
            if *provider != ForgeKind::GitLab {
                return Err(
                    "The glab credential helper is only available for GitLab remotes.".to_string(),
                );
            }
            Ok(TransportCredential::Glab {
                host: actual_credential_host.to_string(),
            })
        }
        GitTransportAuthRef::ProviderToken {
            username,
            provider,
            provider_account_id,
            ..
        } => {
            // `provider` is a typed enum so it can no longer be absent or blank;
            // the id and username stay runtime-checked against blank strings.
            let account_id = non_empty(Some(provider_account_id.as_str())).ok_or_else(|| {
                "The selected account is missing its id. Sign in again.".to_string()
            })?;
            let username = non_empty(Some(username.as_str())).ok_or_else(|| {
                "The selected account is missing its username. Sign in again.".to_string()
            })?;
            Ok(TransportCredential::ProviderToken(ProviderTokenBridge {
                credential_host: actual_credential_host.to_string(),
                username: username.to_string(),
                provider: provider.key().to_string(),
                account_id: account_id.to_string(),
            }))
        }
        GitTransportAuthRef::CredentialHelper { use_http_path, .. } => {
            Ok(TransportCredential::CredentialHelper {
                host: actual_credential_host.to_string(),
                use_http_path: *use_http_path,
            })
        }
        GitTransportAuthRef::System { .. } | GitTransportAuthRef::Ssh { .. } => {
            unreachable!("System and Ssh return before the host check")
        }
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

/// A plausible GitHub login: github.com, EMU (`name_shortcode`) and GHES logins
/// all fit `[A-Za-z0-9._-]{1,100}`. No leading `-`, so it can never read as a
/// `gh` flag.
fn validate_gh_login(login: &str) -> Result<(), String> {
    let login = login.trim();
    let valid = (1..=100).contains(&login.len())
        && !login.starts_with('-')
        && login
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if valid {
        Ok(())
    } else {
        Err("GitHub account binding is invalid; choose the account again.".to_string())
    }
}

fn validate_credential_authority(host: &str) -> Result<(), String> {
    let value = host.trim();
    if value.is_empty() {
        return Err("Invalid git credential helper host.".into());
    }
    if value
        .chars()
        .any(|c| matches!(c, '/' | '\\' | '@' | '\n' | '\r' | '\0'))
    {
        return Err(format!("Invalid git credential helper host '{host}'."));
    }
    let invalid = || format!("Invalid git credential helper host '{host}'.");

    // A bracketed IPv6 literal owns every colon inside its brackets, so only a
    // colon *after* the closing bracket introduces a port. Bare IPv6 stays
    // rejected on purpose: git keys credentials by the bracketed authority, so
    // that is the only spelling a helper would ever be asked about.
    let port = if let Some(rest) = value.strip_prefix('[') {
        let close = rest.find(']').ok_or_else(invalid)?;
        let (literal, after) = (&rest[..close], &rest[close + 1..]);
        if literal.is_empty()
            || !literal
                .chars()
                .all(|c| c.is_ascii_hexdigit() || matches!(c, ':' | '.' | '%' | '-' | '_'))
        {
            return Err(invalid());
        }
        match after {
            "" => None,
            _ => Some(after.strip_prefix(':').ok_or_else(invalid)?),
        }
    } else {
        let (name, port) = match value.rsplit_once(':') {
            Some((name, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
                (name, Some(port))
            }
            Some(_) => return Err(invalid()),
            None => (value, None),
        };
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
        {
            return Err(invalid());
        }
        port
    };
    if let Some(port) = port {
        let parsed = port.parse::<u16>().map_err(|_| invalid())?;
        if parsed == 0 {
            return Err(invalid());
        }
    }
    Ok(())
}

/// Callers run [`validate_credential_authority`] first, which rejects any `/`,
/// so there is no scheme or trailing slash left to strip here.
fn normalize_credential_host(host: &str) -> String {
    host.trim().trim_start_matches("www.").to_ascii_lowercase()
}

#[cfg(test)]
mod tests;
