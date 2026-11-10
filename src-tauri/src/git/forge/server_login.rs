//! Which forge CLI login a repository's pull requests run as, and whether it is
//! usable. Run by the remote agent it describes the server (`remote/ssh-repos`:
//! "The server's forge login is shown with how to fix it"); it never reads a
//! token, only the CLI's own status.

use std::time::Duration;

use super::domain::{host_without_scheme, GithubError};
use super::{detect, ForgeKind};
use crate::git::types::{ForgeServerLogin, GithubAccount};

const GLAB_TIMEOUT: Duration = Duration::from_secs(15);

/// The status of the forge CLI that serves `workdir`'s remote.
pub fn server_login(workdir: &str) -> ForgeServerLogin {
    let Some(remote) = detect(workdir) else {
        return none(None);
    };
    let host = host_without_scheme(&remote.host);
    match remote.kind {
        ForgeKind::GitHub => from_gh(host, super::service::accounts()),
        ForgeKind::GitLab => from_glab(host),
        _ => none(Some(host)),
    }
}

fn none(host: Option<String>) -> ForgeServerLogin {
    ForgeServerLogin {
        provider: None,
        host,
        installed: false,
        supported: false,
        required_version: None,
        login: None,
    }
}

/// `gh`'s answer: the active, healthy account for `host`, the one `gh` acts as
/// when no GitLane account ref is passed (as on the agent).
fn from_gh(host: String, accounts: Result<Vec<GithubAccount>, GithubError>) -> ForgeServerLogin {
    let mut out = ForgeServerLogin {
        provider: Some("gh".into()),
        installed: true,
        supported: true,
        required_version: None,
        login: None,
        host: None,
    };
    match accounts {
        Ok(accounts) => {
            out.login = accounts
                .iter()
                .find(|a| {
                    a.active
                        && a.healthy
                        && host_without_scheme(&a.host).eq_ignore_ascii_case(&host)
                })
                .map(|a| a.login.clone());
        }
        Err(GithubError::ProviderUnavailable { .. }) => {
            out.installed = false;
            out.supported = false;
            out.required_version = Some(super::cli::MIN_GH_VERSION.to_string());
        }
        Err(GithubError::UnsupportedVersion { required, .. }) => {
            out.supported = false;
            out.required_version = Some(required);
        }
        Err(GithubError::GhUnusable { .. }) => out.supported = false,
        // Not logged in, network trouble: installed and usable, no login.
        Err(_) => {}
    }
    out.host = Some(host);
    out
}

/// `glab`'s answer: installed when `glab --version` runs; the login is the
/// `/user` of `glab api --hostname <host> user`, so it is pinned to the host.
fn from_glab(host: String) -> ForgeServerLogin {
    let run = |args: &[&str]| super::probe_glab(args, GLAB_TIMEOUT).ok();
    let installed = run(&["--version"]).is_some_and(|o| o.status.success());
    let login = installed
        .then(|| run(&["api", "--hostname", &host, "user"]))
        .flatten()
        .filter(|o| o.status.success())
        .and_then(|o| glab_login(&String::from_utf8_lossy(&o.stdout)));
    ForgeServerLogin {
        provider: Some("glab".into()),
        host: Some(host),
        installed,
        supported: installed,
        required_version: None,
        login,
    }
}

fn glab_login(json: &str) -> Option<String> {
    crate::git::oauth::identity::parse_gitlab_user(json)
        .ok()
        .map(|user| user.login)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(host: &str, login: &str, active: bool, healthy: bool) -> GithubAccount {
        GithubAccount {
            provider: "gh".into(),
            host: host.into(),
            account_id: login.into(),
            login: login.into(),
            username: login.into(),
            name: String::new(),
            email: String::new(),
            id: 0,
            active,
            healthy,
            health_error: String::new(),
        }
    }

    #[test]
    fn gh_logged_in_reports_the_active_healthy_login_for_the_host() {
        let accounts = vec![
            account("github.com", "inactive", false, true),
            account("ghe.example.test", "other-host", true, true),
            account("https://github.com", "octocat", true, true),
        ];
        let out = from_gh("github.com".into(), Ok(accounts));
        assert_eq!(out.provider.as_deref(), Some("gh"));
        assert_eq!(out.login.as_deref(), Some("octocat"));
        assert!(out.installed && out.supported);
    }

    #[test]
    fn gh_not_logged_in_or_broken_has_no_login() {
        let out = from_gh(
            "github.com".into(),
            Ok(vec![account("github.com", "x", true, false)]),
        );
        assert_eq!(out.login, None);
        assert!(out.installed && out.supported);
        assert_eq!(out.host.as_deref(), Some("github.com"));
    }

    #[test]
    fn gh_missing_or_too_old() {
        let missing = from_gh(
            "github.com".into(),
            Err(GithubError::ProviderUnavailable {
                provider: "gh".into(),
            }),
        );
        assert!(!missing.installed && !missing.supported);
        assert_eq!(missing.required_version.as_deref(), Some("2.95.0"));

        let old = from_gh(
            "github.com".into(),
            Err(GithubError::UnsupportedVersion {
                installed: "2.40.0".into(),
                required: "2.95.0".into(),
            }),
        );
        assert!(old.installed && !old.supported);
        assert_eq!(old.required_version.as_deref(), Some("2.95.0"));
    }

    #[test]
    fn glab_user_json_gives_the_login() {
        assert_eq!(
            glab_login(r#"{"id":42,"username":"ada","name":"Ada"}"#).as_deref(),
            Some("ada")
        );
        assert_eq!(glab_login("not json"), None);
    }

    /// The agent refuses PR providers that need this computer (`remote/ssh-repos`).
    #[test]
    fn agent_refuses_forges_that_need_this_computer() {
        use super::super::service::{provider_for, ON_AGENT};
        use super::super::RemoteForge;
        let remote = |kind| RemoteForge {
            kind,
            host: "example.test".into(),
        };
        ON_AGENT.with(|c| c.set(true));
        for kind in [ForgeKind::Bitbucket, ForgeKind::CursorOrigin] {
            let Err(err) = provider_for(Some(&remote(kind))) else {
                panic!("{kind:?} should be refused on the agent")
            };
            assert!(err
                .to_ipc_string()
                .contains("unavailable for remote repositories"));
            assert_eq!(
                crate::git::types::CommandError::from(err).kind,
                crate::git::types::CommandErrorKind::UnsupportedOnRemote
            );
        }
        for kind in [ForgeKind::GitHub, ForgeKind::GitLab] {
            assert!(provider_for(Some(&remote(kind))).is_ok());
        }
        ON_AGENT.with(|c| c.set(false));
        assert!(provider_for(Some(&remote(ForgeKind::Bitbucket))).is_ok());
    }
}
