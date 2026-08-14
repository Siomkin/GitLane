//! Remote URL and username writes: what userinfo is accepted, how a separate
//! push URL is kept in step, and what is redacted when listing.

use super::super::support::*;

#[test]
fn remote_url_writes_reject_password_userinfo_but_allow_username_selectors() {
    let repo = TempRepo::new("remote-url-password-guard");
    repo.git_ok(&["init", "-q"]);

    let add_error = add_remote(
        repo.path(),
        "origin",
        "https://alice:add-secret@example.com/team/repo.git",
    )
    .unwrap_err();
    assert!(add_error.contains("must not contain"), "{add_error}");
    assert!(!add_error.contains("add-secret"), "{add_error}");
    assert!(
        !repo.git(&["remote", "get-url", "origin"]).status.success(),
        "rejected URL must not create the remote"
    );

    add_remote(
        repo.path(),
        "origin",
        "https://alice@example.com/team/repo.git",
    )
    .expect("username-only remote URL");
    let set_error = set_remote_url(
        repo.path(),
        "origin",
        "http://alice:set-secret@example.com/team/repo.git",
    )
    .unwrap_err();
    assert!(set_error.contains("must not contain"), "{set_error}");
    assert!(!set_error.contains("set-secret"), "{set_error}");
    assert_eq!(
        remote_url(&repo, &["remote", "get-url", "origin"]),
        "https://alice@example.com/team/repo.git",
        "rejected update must leave the prior remote URL intact"
    );
}

#[test]
fn list_remotes_redacts_passwords_configured_outside_gitlane() {
    let repo = TempRepo::new("remote-url-read-redaction");
    repo.git_ok(&["init", "-q"]);
    // Bypass GitLane's guarded writer to model a legacy/external git config.
    repo.git_ok(&[
        "remote",
        "add",
        "origin",
        "https://alice:legacy-secret@example.com/team/repo.git",
    ]);
    repo.git_ok(&[
        "remote",
        "set-url",
        "--push",
        "origin",
        "https://alice:push-secret@example.com/team/repo.git",
    ]);

    let remotes = crate::git::read::list_remotes(repo.path()).unwrap();
    let origin = remotes
        .iter()
        .find(|remote| remote.name == "origin")
        .unwrap();
    assert_eq!(
        origin.fetch_url,
        "https://alice:***@example.com/team/repo.git"
    );
    assert_eq!(
        origin.push_url,
        "https://alice:***@example.com/team/repo.git"
    );
    let serialized = serde_json::to_string(origin).unwrap();
    assert!(!serialized.contains("legacy-secret"));
    assert!(!serialized.contains("push-secret"));
}

#[test]
fn set_remote_url_repoints_a_separate_push_url_too() {
    let repo = TempRepo::new("remote-pushurl");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["remote", "add", "origin", "https://github.com/old/repo.git"]);
    // A *separate* push URL — the case `set-url` (fetch only) would leave stale.
    repo.git_ok(&[
        "remote",
        "set-url",
        "--push",
        "origin",
        "https://github.com/old/push.git",
    ]);

    set_remote_url(repo.path(), "origin", "https://github.com/new/repo.git").unwrap();

    assert_eq!(
        remote_url(&repo, &["remote", "get-url", "origin"]),
        "https://github.com/new/repo.git"
    );
    assert_eq!(
        remote_url(&repo, &["remote", "get-url", "--push", "origin"]),
        "https://github.com/new/repo.git"
    );
}

#[test]
fn remote_edits_refuse_multiple_push_urls_without_partial_mutation() {
    let repo = TempRepo::new("remote-multiple-pushurls");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&[
        "remote",
        "add",
        "origin",
        "https://gitlab.com/upstream/repo.git",
    ]);
    repo.git_ok(&[
        "remote",
        "set-url",
        "--add",
        "--push",
        "origin",
        "https://gitlab.com/one/repo.git",
    ]);
    repo.git_ok(&[
        "remote",
        "set-url",
        "--add",
        "--push",
        "origin",
        "https://gitlab.com/two/repo.git",
    ]);

    assert!(set_remote_url(repo.path(), "origin", "https://example.test/new.git").is_err());
    assert!(set_remote_username(repo.path(), "origin", Some("alice")).is_err());
    assert_eq!(
        remote_url(&repo, &["remote", "get-url", "origin"]),
        "https://gitlab.com/upstream/repo.git"
    );
    let push_urls = repo.git(&["config", "--get-all", "remote.origin.pushurl"]);
    assert_eq!(
        String::from_utf8_lossy(&push_urls.stdout)
            .lines()
            .collect::<Vec<_>>(),
        [
            "https://gitlab.com/one/repo.git",
            "https://gitlab.com/two/repo.git"
        ]
    );
}

#[test]
fn set_remote_username_preserves_separate_push_url_destination() {
    let repo = TempRepo::new("remote-username-pushurl");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&[
        "remote",
        "add",
        "origin",
        "https://gitlab.com/upstream/repo.git",
    ]);
    repo.git_ok(&[
        "remote",
        "set-url",
        "--push",
        "origin",
        "https://gitlab.com/fork/repo.git",
    ]);

    set_remote_username(repo.path(), "origin", Some("alice")).unwrap();

    assert_eq!(
        remote_url(&repo, &["remote", "get-url", "origin"]),
        "https://alice@gitlab.com/upstream/repo.git"
    );
    assert_eq!(
        remote_url(&repo, &["remote", "get-url", "--push", "origin"]),
        "https://alice@gitlab.com/fork/repo.git"
    );

    set_remote_username(repo.path(), "origin", None).unwrap();

    assert_eq!(
        remote_url(&repo, &["remote", "get-url", "origin"]),
        "https://gitlab.com/upstream/repo.git"
    );
    assert_eq!(
        remote_url(&repo, &["remote", "get-url", "--push", "origin"]),
        "https://gitlab.com/fork/repo.git"
    );
}

#[test]
fn set_remote_username_does_not_half_update_when_push_url_is_not_https() {
    let repo = TempRepo::new("remote-username-pushurl-ssh");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&[
        "remote",
        "add",
        "origin",
        "https://gitlab.com/upstream/repo.git",
    ]);
    repo.git_ok(&[
        "remote",
        "set-url",
        "--push",
        "origin",
        "git@gitlab.com:fork/repo.git",
    ]);

    let err = set_remote_username(repo.path(), "origin", Some("alice")).unwrap_err();

    assert!(err.contains("HTTPS remotes"), "{err}");
    assert_eq!(
        remote_url(&repo, &["remote", "get-url", "origin"]),
        "https://gitlab.com/upstream/repo.git"
    );
    assert_eq!(
        remote_url(&repo, &["remote", "get-url", "--push", "origin"]),
        "git@gitlab.com:fork/repo.git"
    );
}

#[test]
fn set_remote_username_does_not_create_push_url_when_push_follows_fetch() {
    let repo = TempRepo::new("remote-username-no-pushurl");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&[
        "remote",
        "add",
        "origin",
        "https://github.com/owner/repo.git",
    ]);

    set_remote_username(repo.path(), "origin", Some("octocat")).unwrap();

    assert!(
        !repo
            .git(&["config", "--get-all", "remote.origin.pushurl"])
            .status
            .success(),
        "username-only auth should not create a separate pushurl"
    );
    assert_eq!(
        remote_url(&repo, &["remote", "get-url", "origin"]),
        "https://octocat@github.com/owner/repo.git"
    );
}

#[test]
fn set_remote_url_leaves_push_following_fetch_when_no_push_url() {
    let repo = TempRepo::new("remote-nopush");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["remote", "add", "origin", "https://github.com/old/repo.git"]);

    set_remote_url(repo.path(), "origin", "https://github.com/new/repo.git").unwrap();

    // No standalone pushurl was created; push transparently follows the fetch URL.
    assert!(
        !repo
            .git(&["config", "--get-all", "remote.origin.pushurl"])
            .status
            .success(),
        "no separate pushurl should be configured"
    );
    assert_eq!(
        remote_url(&repo, &["remote", "get-url", "--push", "origin"]),
        "https://github.com/new/repo.git"
    );
}
