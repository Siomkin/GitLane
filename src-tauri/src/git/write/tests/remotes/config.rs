//! What the remote configuration implies: which remote selects the forge, and
//! how transport credentials resolve across split fetch/push authorities.

use super::super::support::*;

#[test]
fn default_remote_drives_forge_even_when_listed_after_another() {
    let repo = TempRepo::new("remote-default");
    repo.git_ok(&["init", "-q"]);
    // upstream (GitLab) is added first; origin (GitHub) second. origin is the
    // default push remote, so it must win both the Remotes panel and the toolbar.
    repo.git_ok(&[
        "remote",
        "add",
        "upstream",
        "https://gitlab.com/up/stream.git",
    ]);
    repo.git_ok(&["remote", "add", "origin", "https://github.com/me/repo.git"]);

    let remotes = crate::git::read::list_remotes(repo.path()).unwrap();
    let origin = remotes.iter().find(|r| r.name == "origin").unwrap();
    assert!(
        origin.is_default,
        "origin should be the default push remote"
    );
    assert!(
        !remotes
            .iter()
            .find(|r| r.name == "upstream")
            .unwrap()
            .is_default
    );

    // The toolbar provider reflects the default push remote (GitHub), not the
    // first-listed remote (GitLab).
    let forge = crate::git::forge::summary(repo.path());
    assert_eq!(forge.kind.as_deref(), Some("github"));
    assert_eq!(forge.host.as_deref(), Some("github.com"));
}

#[test]
fn forge_detect_prefers_the_default_remote() {
    let repo = TempRepo::new("detect-default");
    repo.git_ok(&["init", "-q"]);
    // upstream (GitLab) first, origin (GitHub, the default) second.
    repo.git_ok(&[
        "remote",
        "add",
        "upstream",
        "https://gitlab.com/up/stream.git",
    ]);
    repo.git_ok(&["remote", "add", "origin", "https://github.com/me/repo.git"]);

    // `detect` (used for gh error classification) reflects the default remote.
    let forge = crate::git::forge::detect(repo.path()).unwrap();
    assert_eq!(forge.kind, crate::git::forge::ForgeKind::GitHub);
}

#[test]
fn transport_credentials_follow_split_fetch_and_push_authorities() {
    let repo = TempRepo::new("remote-host-for");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&[
        "remote",
        "add",
        "origin",
        "https://fetch-user@fetch-auth.example.test:8443/owner/repo.git",
    ]);
    assert_eq!(
        crate::git::forge::remote_credential_host_for(
            repo.path(),
            "origin",
            RemoteTransportDirection::Fetch,
        )
        .as_deref(),
        Some("fetch-auth.example.test:8443")
    );
    assert_eq!(
        crate::git::forge::remote_credential_host_for(
            repo.path(),
            "origin",
            RemoteTransportDirection::Push,
        )
        .as_deref(),
        Some("fetch-auth.example.test:8443"),
        "push must fall back to the fetch URL when no push URL is configured"
    );
    repo.git_ok(&[
        "remote",
        "set-url",
        "--push",
        "origin",
        "https://push-user@push-auth.example.test:9443/team/repo.git",
    ]);

    assert_eq!(
        crate::git::forge::remote_credential_host_for(
            repo.path(),
            "origin",
            RemoteTransportDirection::Fetch,
        )
        .as_deref(),
        Some("fetch-auth.example.test:8443")
    );
    assert_eq!(
        crate::git::forge::remote_credential_host_for(
            repo.path(),
            "origin",
            RemoteTransportDirection::Push,
        )
        .as_deref(),
        Some("push-auth.example.test:9443")
    );

    let auth = |credential_host: &str, username: &str, account_id: &str| GitTransportAuthRef {
        mode: "providerToken".into(),
        provider: Some("gitlab".into()),
        host: credential_host.split(':').next().unwrap().into(),
        credential_host: credential_host.into(),
        username: Some(username.into()),
        account_ref: None,
        provider_account_id: Some(account_id.into()),
        use_http_path: false,
    };
    let fetch_auth = auth(
        "fetch-auth.example.test:8443",
        "fetch-sentinel",
        "fetch-account",
    );
    let push_auth = auth(
        "push-auth.example.test:9443",
        "push-sentinel",
        "push-account",
    );

    assert_eq!(
        credential_for_remote(
            repo.path(),
            "origin",
            RemoteTransportDirection::Fetch,
            Some(&fetch_auth),
        )
        .expect("fetch auth matches fetch URL"),
        TransportCredential::ProviderToken(ProviderTokenBridge {
            credential_host: "fetch-auth.example.test:8443".into(),
            username: "fetch-sentinel".into(),
            provider: "gitlab".into(),
            account_id: "fetch-account".into(),
        })
    );
    assert_eq!(
        credential_for_remote(
            repo.path(),
            "origin",
            RemoteTransportDirection::Push,
            Some(&push_auth),
        )
        .expect("push auth matches push URL"),
        TransportCredential::ProviderToken(ProviderTokenBridge {
            credential_host: "push-auth.example.test:9443".into(),
            username: "push-sentinel".into(),
            provider: "gitlab".into(),
            account_id: "push-account".into(),
        })
    );
    let err = credential_for_remote(
        repo.path(),
        "origin",
        RemoteTransportDirection::Fetch,
        Some(&push_auth),
    )
    .expect_err("push authority must not authenticate fetch");
    assert!(err.contains("fetch-auth.example.test:8443"), "{err}");
    assert!(err.contains("push-auth.example.test:9443"), "{err}");

    assert_eq!(
        crate::git::forge::remote_credential_host_for(
            repo.path(),
            "missing",
            RemoteTransportDirection::Fetch,
        ),
        None
    );
}

#[test]
fn the_local_tracking_pseudo_remote_never_resolves_credentials() {
    // "." is git's pseudo-remote for a branch tracking another *local* branch:
    // it has no URL, so it must short-circuit to no inline credential even
    // with an auth ref present, rather than failing resolution with a
    // misleading "Remote '.' was not found" error.
    let repo = TempRepo::new("dot-pseudo-remote");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["remote", "add", "origin", "https://github.com/me/repo.git"]);
    let auth = GitTransportAuthRef {
        mode: "providerToken".into(),
        provider: Some("github".into()),
        host: "github.com".into(),
        credential_host: "github.com".into(),
        username: Some("me".into()),
        account_ref: None,
        provider_account_id: Some("account".into()),
        use_http_path: false,
    };
    for direction in [
        RemoteTransportDirection::Fetch,
        RemoteTransportDirection::Push,
    ] {
        assert_eq!(
            crate::commands::remotes::transport_cred(repo.path(), ".", direction, Some(&auth))
                .expect("'.' never reaches credential resolution"),
            TransportCredential::None
        );
    }
}

#[test]
fn the_default_push_remote_is_never_the_local_tracking_pseudo_remote() {
    // A branch tracking another local branch makes `default_remote` report
    // ".", which is a real operand for a branch push but silently wrong for a
    // tag: `push --delete . refs/tags/v1` deletes the *local* tag and leaves
    // the remote copy for the next fetch to resurrect.
    let (repo, _head) = repo_with_base_commit("dot-default-push-remote");
    repo.git_ok(&["branch", "base"]);
    repo.git_ok(&["checkout", "-q", "-b", "topic", "--track", "base"]);
    assert_eq!(
        crate::git::forge::default_remote(repo.path()).as_deref(),
        Some("."),
        "the branch must be in the shape that reports the pseudo-remote"
    );

    assert_eq!(
        crate::commands::remotes::push_remote_or_default(repo.path(), None),
        "origin"
    );
    // An explicit remote still wins.
    assert_eq!(
        crate::commands::remotes::push_remote_or_default(repo.path(), Some("upstream".into())),
        "upstream"
    );
}
