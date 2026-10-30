use super::*;
use crate::git::forge::ForgeKind;
use crate::git::types::GithubAccountRef;

fn gh_auth(host: &str) -> GitTransportAuthRef {
    GitTransportAuthRef::GithubGh {
        host: host.split(':').next().unwrap_or(host).into(),
        credential_host: host.into(),
        username: Some("octocat".into()),
        account_ref: GithubAccountRef {
            provider: "gh".into(),
            host: host.into(),
            account_id: "1".into(),
            login: "octocat".into(),
        },
    }
}

fn provider_token_auth(host: &str) -> GitTransportAuthRef {
    GitTransportAuthRef::ProviderToken {
        host: host.split(':').next().unwrap_or(host).into(),
        credential_host: host.into(),
        username: "alice".into(),
        provider: ForgeKind::GitLab,
        provider_account_id: "42".into(),
    }
}

#[test]
fn github_helper_preserves_custom_port() {
    let cred =
        credential_for_credential_host("ghe.example.test:8443", &gh_auth("ghe.example.test:8443"))
            .expect("valid auth");
    assert_eq!(
        cred,
        TransportCredential::Gh {
            host: "ghe.example.test:8443".into(),
            gh_host: "ghe.example.test:8443".into(),
            login: "octocat".into(),
        }
    );
}

#[test]
fn github_helper_matches_www_host_but_preserves_scope() {
    let mut auth = gh_auth("www.github.com");
    let GitTransportAuthRef::GithubGh { account_ref, .. } = &mut auth else {
        unreachable!("gh_auth builds the githubGh variant")
    };
    account_ref.host = "github.com".into();

    let cred = credential_for_credential_host("www.github.com", &auth).expect("valid auth");

    // The helper is scoped to the remote's spelling, but gh is asked for
    // the token under the account's own hostname.
    assert_eq!(
        cred,
        TransportCredential::Gh {
            host: "www.github.com".into(),
            gh_host: "github.com".into(),
            login: "octocat".into(),
        }
    );
}

#[test]
fn github_helper_pins_an_emu_login() {
    let mut auth = gh_auth("github.com");
    let GitTransportAuthRef::GithubGh { account_ref, .. } = &mut auth else {
        unreachable!("gh_auth builds the githubGh variant")
    };
    account_ref.login = "octocat_acme".into();

    assert_eq!(
        credential_for_credential_host("github.com", &auth).expect("valid auth"),
        TransportCredential::Gh {
            host: "github.com".into(),
            gh_host: "github.com".into(),
            login: "octocat_acme".into(),
        }
    );
}

#[test]
fn github_helper_refuses_a_login_that_could_escape_the_helper_shell() {
    for login in ["bob'; rm -rf ~; '", "$(id)", "a b", "-x", ""] {
        let mut auth = gh_auth("github.com");
        let GitTransportAuthRef::GithubGh { account_ref, .. } = &mut auth else {
            unreachable!("gh_auth builds the githubGh variant")
        };
        account_ref.login = login.into();
        let err = credential_for_credential_host("github.com", &auth)
            .expect_err("malicious login must be refused");
        assert!(err.contains("choose the account again"), "{login:?}: {err}");
    }
}

#[test]
fn github_helper_refuses_an_account_host_that_could_escape_the_helper_shell() {
    for host in ["github.com'", "github.com$x", "github.com;x", "github .com"] {
        let mut auth = gh_auth("github.com");
        let GitTransportAuthRef::GithubGh { account_ref, .. } = &mut auth else {
            unreachable!("gh_auth builds the githubGh variant")
        };
        account_ref.host = host.into();
        // The authority charset must be what refuses it, not the later
        // account-host/remote-host mismatch check.
        let err = credential_for_credential_host("github.com", &auth)
            .expect_err("shell-unsafe account host must be refused");
        assert!(
            err.contains("Invalid git credential helper host"),
            "{host:?}: {err}"
        );
    }
}

#[test]
fn gh_login_accepts_github_emu_and_ghes_shapes() {
    for login in ["octocat", "octocat_acme", "a.b-c", &"a".repeat(100)] {
        assert!(validate_gh_login(login).is_ok(), "{login:?}");
    }
    for login in [
        "",
        "-x",
        "bob'; rm -rf ~; '",
        "a b",
        "a\nb",
        &"a".repeat(101),
    ] {
        assert!(validate_gh_login(login).is_err(), "{login:?}");
    }
}

#[test]
fn credential_helper_mode_does_not_inject_a_helper() {
    let auth = GitTransportAuthRef::CredentialHelper {
        host: "gitlab.com".into(),
        credential_host: "gitlab.com".into(),
        username: Some("alice".into()),
        use_http_path: false,
    };
    assert_eq!(
        credential_for_credential_host("gitlab.com", &auth).expect("valid auth"),
        TransportCredential::CredentialHelper {
            host: "gitlab.com".into(),
            use_http_path: false,
        }
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
    // Blank account id → cannot locate the keychain entry.
    let mut auth = provider_token_auth("gitlab.com");
    if let GitTransportAuthRef::ProviderToken {
        provider_account_id,
        ..
    } = &mut auth
    {
        provider_account_id.clear();
    }
    assert!(credential_for_credential_host("gitlab.com", &auth).is_err());

    // Blank username → git could not be answered.
    let mut auth = provider_token_auth("gitlab.com");
    if let GitTransportAuthRef::ProviderToken { username, .. } = &mut auth {
        username.clear();
    }
    assert!(credential_for_credential_host("gitlab.com", &auth).is_err());
}

#[test]
fn provider_token_rejects_a_host_mismatch() {
    let err = credential_for_credential_host("gitlab.com", &provider_token_auth("gitlab.other"))
        .unwrap_err();
    assert!(err.contains("selected account"), "{err}");
}

fn glab_auth(host: &str) -> GitTransportAuthRef {
    GitTransportAuthRef::GitlabGlab {
        host: host.split(':').next().unwrap_or(host).into(),
        credential_host: host.into(),
        username: Some("ada".into()),
        provider: ForgeKind::GitLab,
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
    if let GitTransportAuthRef::GitlabGlab { provider, .. } = &mut auth {
        *provider = ForgeKind::Bitbucket;
    }
    assert!(credential_for_credential_host("gitlab.com", &auth).is_err());
}

#[test]
fn gitlab_glab_rejects_host_mismatch() {
    let err = credential_for_credential_host("gitlab.com", &glab_auth("gitlab.other")).unwrap_err();
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
            host: "github.com".into(),
            gh_host: "github.com".into(),
            login: "octocat".into(),
        }
    );
    assert_eq!(
        credential_for_credential_host("ghe.example.test", &ghes).unwrap(),
        TransportCredential::Gh {
            host: "ghe.example.test".into(),
            gh_host: "ghe.example.test".into(),
            login: "octocat".into(),
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

/// A bracketed IPv6 literal owns every colon inside its brackets, so the
/// host validation must not read one of them as a port separator. Git keys
/// credentials by the bracketed authority, so that is the only spelling a
/// helper is ever asked about — the bare form stays rejected deliberately.
#[test]
fn helper_host_accepts_bracketed_ipv6_authorities() {
    for host in ["[::1]", "[::1]:8443", "[2001:db8::1]", "[2001:db8::1]:443"] {
        assert!(
            credential_for_credential_host(host, &gh_auth(host)).is_ok(),
            "{host} should be a valid credential helper host",
        );
    }
}

#[test]
fn helper_host_rejects_malformed_ipv6_authorities() {
    for host in [
        "::1",         // bare — git would never key a credential this way
        "[::1",        // unclosed literal
        "[]",          // empty literal
        "[::1]x",      // trailing text where a port separator must be
        "[::1]:",      // separator with no port
        "[::1]:0",     // port 0 is not a real port
        "[::1]:70000", // outside the valid TCP port range
        "[::1]:https", // non-numeric port
        "[evil/path]", // not an address at all
        // A link-local zone id (RFC 6874 `%25<zone>`) is rejected too: the
        // literal charset is hex digits and address punctuation, and a zone
        // name like `eth0` falls outside it. Declining a spelling git would
        // essentially never key a credential by is the safe direction.
        "[fe80::1%25eth0]",
    ] {
        let err = credential_for_credential_host(host, &gh_auth(host)).unwrap_err();
        assert!(
            err.contains("Invalid git credential helper host"),
            "{host}: {err}",
        );
    }
}

#[test]
fn credential_helper_preserves_path_scope_for_an_ipv6_authority() {
    let authority = "[2001:db8::1]:8443";
    let auth = GitTransportAuthRef::CredentialHelper {
        host: "[2001:db8::1]".into(),
        credential_host: authority.into(),
        username: Some("alice".into()),
        use_http_path: true,
    };
    assert_eq!(
        credential_for_credential_host(authority, &auth).unwrap(),
        TransportCredential::CredentialHelper {
            host: authority.into(),
            use_http_path: true,
        }
    );
}

#[test]
fn server_gh_picks_the_active_healthy_account_for_the_remote_host() {
    let account =
        |host: &str, login: &str, active: bool, healthy: bool| crate::git::types::GithubAccount {
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
        };
    let accounts = [
        account("github.com", "other", false, true),
        account("github.com", "octocat", true, true),
        account("ghe.example.com", "broken", true, false),
    ];
    assert_eq!(
        pick_server_gh(&accounts, "github.com"),
        Some(TransportCredential::Gh {
            host: "github.com".into(),
            gh_host: "github.com".into(),
            login: "octocat".into(),
        })
    );
    assert_eq!(pick_server_gh(&accounts, "ghe.example.com"), None);
    assert_eq!(pick_server_gh(&accounts, "gitlab.com"), None);
    assert_eq!(
        pick_server_gh(&[account("github.com", "a;b", true, true)], "github.com"),
        None
    );
}

#[test]
fn without_server_gh_an_unbound_remote_uses_git_s_own_helpers() {
    // The desktop never turns the switch on; a missing repo also gets None.
    assert_eq!(
        server_gh_credential("/nonexistent", "origin", RemoteTransportDirection::Fetch),
        TransportCredential::None
    );
}
