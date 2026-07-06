//! Provider-neutral git transport auth for real-`git` network operations.
//!
//! Transport auth refs never carry tokens. For HTTPS remotes the selected
//! identity is represented by the URL username, which Git passes to credential
//! helpers (`gitcredentials(7)`). GitHub is the only provider where GitLane
//! injects a helper inline (`gh auth git-credential`); other providers are
//! handled by the user's configured helper / Git Credential Manager.

use crate::git::types::GitTransportAuthRef;

use super::forge;

pub fn helper_host_for_remote(
    workdir: &str,
    remote: &str,
    auth: Option<&GitTransportAuthRef>,
) -> Result<Option<String>, String> {
    let Some(auth) = auth else {
        return Ok(None);
    };
    let Some(remote_host) = forge::remote_credential_host_for(workdir, remote) else {
        return Err(format!(
            "Remote '{remote}' was not found or has no URL configured."
        ));
    };
    helper_host_for_credential_host(&remote_host, auth).map_err(|err| {
        if err.contains("selected account") {
            err.replace("this remote", &format!("remote '{remote}'"))
        } else {
            err
        }
    })
}

pub fn helper_host_for_url(
    url: &str,
    auth: Option<&GitTransportAuthRef>,
) -> Result<Option<String>, String> {
    let Some(auth) = auth else {
        return Ok(None);
    };
    let Some(url_host) = forge::credential_host_for_url(url) else {
        return Ok(None);
    };
    helper_host_for_credential_host(&url_host, auth)
}

fn helper_host_for_credential_host(
    actual_credential_host: &str,
    auth: &GitTransportAuthRef,
) -> Result<Option<String>, String> {
    let mode = auth.mode.as_str();
    if matches!(mode, "system" | "ssh") {
        return Ok(None);
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
            Ok(Some(actual_credential_host.to_string()))
        }
        "credentialHelper" => Ok(None),
        other => Err(format!("Unsupported git transport auth mode '{other}'.")),
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
        }
    }

    #[test]
    fn github_helper_preserves_custom_port() {
        let helper = helper_host_for_credential_host(
            "ghe.example.test:8443",
            &gh_auth("ghe.example.test:8443"),
        )
        .expect("valid auth");
        assert_eq!(helper.as_deref(), Some("ghe.example.test:8443"));
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
        };
        assert_eq!(
            helper_host_for_credential_host("gitlab.com", &auth).expect("valid auth"),
            None
        );
    }

    #[test]
    fn stale_remote_host_is_rejected() {
        let err = helper_host_for_credential_host("github.com", &gh_auth("ghe.example.test"))
            .unwrap_err();
        assert!(err.contains("selected account"), "{err}");
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
            let err = helper_host_for_credential_host(host, &gh_auth(host)).unwrap_err();
            assert!(err.contains("Invalid git credential helper host"), "{err}");
        }
    }
}
