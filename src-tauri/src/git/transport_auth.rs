//! Provider-neutral git transport auth for real-`git` network operations.
//!
//! Transport auth refs never carry tokens. For HTTPS remotes the selected
//! identity is represented by the URL username, which Git passes to credential
//! helpers (`gitcredentials(7)`). GitHub injects a helper inline
//! (`gh auth git-credential`); providers whose token GitLane owns itself use the
//! keychain-backed [`credential_bridge`](super::credential_bridge) via
//! `GIT_ASKPASS` (`providerToken` mode); every other remote is handled by the
//! user's configured helper / Git Credential Manager.
//!
//! Resolution yields a [`TransportCredential`] — the *strategy* for one git
//! network invocation. It still carries no secret: the `ProviderToken` variant
//! holds only a non-secret keychain locator, which the bridge exchanges for the
//! token inside a child process.

use crate::git::types::GitTransportAuthRef;

use super::forge;

/// How one git network invocation should obtain HTTPS credentials. Carries no
/// secret material — see the module docs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportCredential {
    /// No inline handling: SSH, or the user's own credential helper / GCM.
    None,
    /// GitHub `gh` credential helper for `host` (account chosen by URL username).
    Gh { host: String },
    /// GitLab `glab` credential helper for `host`: glab is signed in and answers
    /// git's credential prompt from its own token store. Mirrors `Gh` for GitLab
    /// remotes so a glab sign-in provides transport with zero config (GL-139).
    Glab { host: String },
    /// A GitLane-owned provider token, fed to git from the OS keychain via the
    /// `GIT_ASKPASS` bridge. Fields are all non-secret locators.
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

pub fn credential_for_remote(
    workdir: &str,
    remote: &str,
    auth: Option<&GitTransportAuthRef>,
) -> Result<TransportCredential, String> {
    let Some(auth) = auth else {
        return Ok(TransportCredential::None);
    };
    let Some(remote_host) = forge::remote_credential_host_for(workdir, remote) else {
        return Err(format!(
            "Remote '{remote}' was not found or has no URL configured."
        ));
    };
    credential_for_credential_host(&remote_host, auth).map_err(|err| {
        if err.contains("selected account") {
            err.replace("this remote", &format!("remote '{remote}'"))
        } else {
            err
        }
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
    credential_for_credential_host(&url_host, auth)
}

fn credential_for_credential_host(
    actual_credential_host: &str,
    auth: &GitTransportAuthRef,
) -> Result<TransportCredential, String> {
    let mode = auth.mode.as_str();
    if matches!(mode, "system" | "ssh") {
        return Ok(TransportCredential::None);
    }

    validate_credential_authority(actual_credential_host)?;
    validate_credential_authority(&auth.credential_host)?;
    let expected = normalize_credential_host(&auth.credential_host);
    let actual = normalize_credential_host(actual_credential_host);
    if !expected.is_empty() && expected != actual {
        return Err(format!(
            "The selected account is for {}, but this remote uses {}.",
            auth.credential_host, actual_credential_host
        ));
    }

    match mode {
        "githubGh" => {
            let account = auth.account_ref.as_ref().ok_or_else(|| {
                "The selected GitHub account is missing. Refresh accounts and try again."
                    .to_string()
            })?;
            if account.provider != "gh" {
                return Err(format!(
                    "GitHub provider '{}' is not available for git transport auth.",
                    account.provider
                ));
            }
            validate_credential_authority(&account.host)?;
            let account_host = normalize_credential_host(&account.host);
            if account_host != actual {
                return Err(format!(
                    "The selected account signs in to {}, but this remote uses {}.",
                    account.host, actual_credential_host
                ));
            }
            Ok(TransportCredential::Gh {
                host: actual_credential_host.to_string(),
            })
        }
        "gitlabGlab" => {
            // glab is single-account per host and answers for whatever it is
            // signed into, so there is no account_ref to match — but the mode is
            // GitLab-only, so refuse to inject glab's helper for any other
            // provider's remote.
            if non_empty(auth.provider.as_deref()) != Some("gitlab") {
                return Err(
                    "The glab credential helper is only available for GitLab remotes.".to_string(),
                );
            }
            Ok(TransportCredential::Glab {
                host: actual_credential_host.to_string(),
            })
        }
        "providerToken" => {
            let provider = non_empty(auth.provider.as_deref()).ok_or_else(|| {
                "The selected account is missing its provider. Sign in again.".to_string()
            })?;
            let account_id = non_empty(auth.provider_account_id.as_deref()).ok_or_else(|| {
                "The selected account is missing its id. Sign in again.".to_string()
            })?;
            let username = non_empty(auth.username.as_deref()).ok_or_else(|| {
                "The selected account is missing its username. Sign in again.".to_string()
            })?;
            Ok(TransportCredential::ProviderToken(ProviderTokenBridge {
                credential_host: actual_credential_host.to_string(),
                username: username.to_string(),
                provider: provider.to_string(),
                account_id: account_id.to_string(),
            }))
        }
        "credentialHelper" => Ok(TransportCredential::None),
        other => Err(format!("Unsupported git transport auth mode '{other}'.")),
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
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
    let (name, port) = match value.rsplit_once(':') {
        Some((name, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
            (name, Some(port))
        }
        Some(_) => return Err(format!("Invalid git credential helper host '{host}'.")),
        None => (value, None),
    };
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
    {
        return Err(format!("Invalid git credential helper host '{host}'."));
    }
    if port == Some("0") {
        return Err(format!("Invalid git credential helper host '{host}'."));
    }
    Ok(())
}

fn normalize_credential_host(host: &str) -> String {
    host.trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .trim_start_matches("www.")
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::types::GithubAccountRef;

    fn gh_auth(host: &str) -> GitTransportAuthRef {
        GitTransportAuthRef {
            mode: "githubGh".into(),
            provider: Some("github".into()),
            host: host.split(':').next().unwrap_or(host).into(),
            credential_host: host.into(),
            username: Some("octocat".into()),
            account_ref: Some(GithubAccountRef {
                provider: "gh".into(),
                host: host.into(),
                account_id: "1".into(),
                login: "octocat".into(),
            }),
            provider_account_id: None,
        }
    }

    fn provider_token_auth(host: &str) -> GitTransportAuthRef {
        GitTransportAuthRef {
            mode: "providerToken".into(),
            provider: Some("gitlab".into()),
            host: host.split(':').next().unwrap_or(host).into(),
            credential_host: host.into(),
            username: Some("alice".into()),
            account_ref: None,
            provider_account_id: Some("42".into()),
        }
    }

    #[test]
    fn github_helper_preserves_custom_port() {
        let cred = credential_for_credential_host(
            "ghe.example.test:8443",
            &gh_auth("ghe.example.test:8443"),
        )
        .expect("valid auth");
        assert_eq!(
            cred,
            TransportCredential::Gh {
                host: "ghe.example.test:8443".into()
            }
        );
    }

    #[test]
    fn github_helper_matches_www_host_but_preserves_scope() {
        let mut auth = gh_auth("www.github.com");
        auth.account_ref.as_mut().unwrap().host = "github.com".into();

        let cred = credential_for_credential_host("www.github.com", &auth).expect("valid auth");

        assert_eq!(
            cred,
            TransportCredential::Gh {
                host: "www.github.com".into()
            }
        );
    }

    #[test]
    fn credential_helper_mode_does_not_inject_a_helper() {
        let auth = GitTransportAuthRef {
            mode: "credentialHelper".into(),
            provider: Some("gitlab".into()),
            host: "gitlab.com".into(),
            credential_host: "gitlab.com".into(),
            username: Some("alice".into()),
            account_ref: None,
            provider_account_id: None,
        };
        assert_eq!(
            credential_for_credential_host("gitlab.com", &auth).expect("valid auth"),
            TransportCredential::None
        );
    }

    #[test]
    fn provider_token_resolves_a_keychain_bridge_preserving_port() {
        let cred = credential_for_credential_host(
            "gitlab.example.test:8443",
            &provider_token_auth("gitlab.example.test:8443"),
        )
        .expect("valid auth");
        assert_eq!(
            cred,
            TransportCredential::ProviderToken(ProviderTokenBridge {
                credential_host: "gitlab.example.test:8443".into(),
                username: "alice".into(),
                provider: "gitlab".into(),
                account_id: "42".into(),
            })
        );
    }

    #[test]
    fn provider_token_requires_locator_fields() {
        // Missing account id → cannot locate the keychain entry.
        let mut auth = provider_token_auth("gitlab.com");
        auth.provider_account_id = None;
        assert!(credential_for_credential_host("gitlab.com", &auth).is_err());

        // Missing username → git could not be answered.
        let mut auth = provider_token_auth("gitlab.com");
        auth.username = None;
        assert!(credential_for_credential_host("gitlab.com", &auth).is_err());
    }

    #[test]
    fn provider_token_rejects_a_host_mismatch() {
        let err =
            credential_for_credential_host("gitlab.com", &provider_token_auth("gitlab.other"))
                .unwrap_err();
        assert!(err.contains("selected account"), "{err}");
    }

    fn glab_auth(host: &str) -> GitTransportAuthRef {
        GitTransportAuthRef {
            mode: "gitlabGlab".into(),
            provider: Some("gitlab".into()),
            host: host.split(':').next().unwrap_or(host).into(),
            credential_host: host.into(),
            username: Some("ada".into()),
            account_ref: None,
            provider_account_id: None,
        }
    }

    #[test]
    fn gitlab_glab_helper_resolves_for_gitlab_remotes() {
        let cred =
            credential_for_credential_host("gitlab.com", &glab_auth("gitlab.com")).expect("valid");
        assert_eq!(
            cred,
            TransportCredential::Glab {
                host: "gitlab.com".into()
            }
        );
    }

    #[test]
    fn gitlab_glab_preserves_custom_port() {
        let cred = credential_for_credential_host(
            "gitlab.example.test:8443",
            &glab_auth("gitlab.example.test:8443"),
        )
        .expect("valid");
        assert_eq!(
            cred,
            TransportCredential::Glab {
                host: "gitlab.example.test:8443".into()
            }
        );
    }

    #[test]
    fn gitlab_glab_refuses_non_gitlab_provider() {
        // Guards against injecting glab's helper for another provider's remote.
        let mut auth = glab_auth("gitlab.com");
        auth.provider = Some("bitbucket".into());
        assert!(credential_for_credential_host("gitlab.com", &auth).is_err());
    }

    #[test]
    fn gitlab_glab_rejects_host_mismatch() {
        let err = credential_for_credential_host("gitlab.com", &glab_auth("gitlab.other"))
            .unwrap_err();
        assert!(err.contains("selected account"), "{err}");
    }

    #[test]
    fn stale_remote_host_is_rejected() {
        let err =
            credential_for_credential_host("github.com", &gh_auth("ghe.example.test")).unwrap_err();
        assert!(err.contains("selected account"), "{err}");
    }

    #[test]
    fn same_login_on_different_github_hosts_stays_distinct() {
        // Two GitHub accounts share a login across github.com and a GHES host
        // (GL-133): each authenticates only its own host, and the GHES host is
        // never collapsed to github.com.
        let dotcom = gh_auth("github.com");
        let ghes = gh_auth("ghe.example.test");

        assert_eq!(
            credential_for_credential_host("github.com", &dotcom).unwrap(),
            TransportCredential::Gh {
                host: "github.com".into()
            }
        );
        assert_eq!(
            credential_for_credential_host("ghe.example.test", &ghes).unwrap(),
            TransportCredential::Gh {
                host: "ghe.example.test".into()
            }
        );
        // The github.com account must not authenticate the GHES remote.
        assert!(credential_for_credential_host("ghe.example.test", &dotcom).is_err());
    }

    #[test]
    fn helper_host_rejects_malformed_config_scope_hosts() {
        for host in [
            "github.com/foo",
            "github.com\nhelper=!evil",
            "github.com@evil.example",
            "github.com:abc",
            "github.com:0",
        ] {
            let err = credential_for_credential_host(host, &gh_auth(host)).unwrap_err();
            assert!(err.contains("Invalid git credential helper host"), "{err}");
        }
    }
}
