//! Where a push goes: pushRemote vs the fetch upstream, pushDefault, the
//! pinned refspec, and publishing a new branch.

use super::super::support::*;

#[test]
fn network_branch_writes_reject_a_stale_local_tip_before_transport() {
    let (repo, base) = repo_with_base_commit("guarded-network-writes");
    repo.git_ok(&["config", "branch.main.remote", "origin"]);
    repo.git_ok(&["config", "branch.main.merge", "refs/heads/main"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "moved"]);

    assert!(pull_branch(
        repo.path(),
        "main",
        &base,
        "origin",
        "refs/heads/main",
        &TransportCredential::None,
    )
    .is_err());
    assert!(push_branch(repo.path(), "main", &base, &TransportCredential::None).is_err());
    assert!(publish_branch(
        repo.path(),
        "main",
        &base,
        "origin/main",
        &TransportCredential::None,
    )
    .is_err());
    let endpoint_token = push_endpoint_token(repo.path(), "origin").expect("endpoint");
    let route = ForcePushRouteLease {
        remote: "origin".to_string(),
        destination_ref: "refs/heads/main".to_string(),
        destination_oid: None,
        push_endpoint_token: endpoint_token,
    };
    assert!(force_push(
        repo.path(),
        "main",
        &base,
        &route,
        &TransportCredential::None,
    )
    .is_err());
}

#[test]
fn pinned_push_refspec_uses_the_captured_oid_as_its_source() {
    let (repo, head) = repo_with_base_commit("pinned-push-refspec");
    repo.git_ok(&["config", "branch.main.remote", "mirror"]);
    repo.git_ok(&["config", "branch.main.merge", "refs/heads/review"]);

    let (remote, refspec) = push_target_at(repo.path(), "main", &head);

    assert_eq!(remote, "mirror");
    assert_eq!(refspec, format!("{head}:refs/heads/review"));
}

#[test]
fn push_target_honors_push_remote_over_the_fetch_upstream() {
    let (repo, head) = repo_with_base_commit("push-remote-precedence");
    repo.git_ok(&["config", "branch.main.remote", "upstream"]);
    repo.git_ok(&["config", "branch.main.merge", "refs/heads/review"]);
    repo.git_ok(&["config", "branch.main.pushRemote", "fork"]);

    let (remote, refspec) = push_target_at(repo.path(), "main", &head);

    // Triangular: the push goes to the fork, and the fetch upstream's divergent
    // branch name must not leak onto it — same-named branch, like git push.
    assert_eq!(remote, "fork");
    assert_eq!(refspec, format!("{head}:refs/heads/main"));
}

#[test]
fn push_target_honors_push_default_and_lets_push_remote_override_it() {
    let (repo, head) = repo_with_base_commit("push-default-precedence");
    repo.git_ok(&["config", "branch.main.remote", "upstream"]);
    repo.git_ok(&["config", "remote.pushDefault", "fork"]);

    let (remote, _) = push_target_at(repo.path(), "main", &head);
    assert_eq!(remote, "fork");

    repo.git_ok(&["config", "branch.main.pushRemote", "mirror"]);
    let (remote, _) = push_target_at(repo.path(), "main", &head);
    assert_eq!(remote, "mirror");
}

#[test]
fn missing_remote_ref_rejection_is_recognized() {
    // The smart-HTTP wording (GitHub et al.) that delete_remote_tag maps to Ok.
    assert!(is_missing_remote_ref(
        "error: unable to delete 'refs/tags/v9': remote ref does not exist\nerror: failed to push some refs to 'https://github.com/o/r.git'"
    ));
    // Genuine failures must still surface.
    assert!(!is_missing_remote_ref(
        "error: failed to push some refs to 'https://github.com/o/r.git' (protected tag)"
    ));
}

#[test]
fn publish_branch_validates_upstream_format_before_pushing() {
    let (repo, head) = repo_with_base_commit("publish-validate");
    // All of these fail format/operand validation before any network push, so
    // the offline origin is never contacted.
    assert!(
        publish_branch(
            repo.path(),
            "main",
            &head,
            "originmain",
            &TransportCredential::None
        )
        .is_err(),
        "missing slash must be rejected"
    );
    assert!(
        publish_branch(
            repo.path(),
            "main",
            &head,
            "/main",
            &TransportCredential::None
        )
        .is_err(),
        "empty remote half must be rejected"
    );
    assert!(
        publish_branch(
            repo.path(),
            "main",
            &head,
            "origin/",
            &TransportCredential::None
        )
        .is_err(),
        "empty branch half must be rejected"
    );
    assert!(
        publish_branch(
            repo.path(),
            "--upload-pack=x",
            &head,
            "origin/main",
            &TransportCredential::None
        )
        .is_err(),
        "option-like branch operand must be rejected"
    );
}

#[test]
fn publish_branch_pushes_the_captured_oid_and_sets_tracking_config() {
    let remote = TempRepo::new("publish-pinned-remote");
    remote.git_ok(&["init", "-q", "--bare"]);
    let (repo, head) = repo_with_base_commit("publish-pinned-local");
    repo.git_ok(&["remote", "set-url", "origin", remote.path()]);

    publish_branch(
        repo.path(),
        "main",
        &head,
        "origin/review",
        &TransportCredential::None,
    )
    .expect("publish captured commit");

    assert_eq!(rev_parse(&remote, "refs/heads/review"), head);
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["config", "branch.main.remote"]).stdout).trim(),
        "origin"
    );
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["config", "branch.main.merge"]).stdout).trim(),
        "refs/heads/review"
    );
}

#[test]
fn push_remote_helpers_resolve_branch_config_and_fall_back_to_origin() {
    let repo = TempRepo::new("push-remote-helpers");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), "x\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);

    // No branch config → origin fallback (mirrors push_target).
    assert_eq!(branch_push_remote(repo.path(), "main"), "origin");
    assert_eq!(head_push_remote(repo.path()), "origin");

    // The configured push remote wins, for the named branch and for HEAD.
    repo.git_ok(&["config", "branch.main.remote", "mirror"]);
    assert_eq!(branch_push_remote(repo.path(), "main"), "mirror");
    assert_eq!(head_push_remote(repo.path()), "mirror");

    // A local-tracking branch (`.`) is a valid push target. The command layer
    // bypasses transport auth for it rather than silently retargeting origin.
    repo.git_ok(&["config", "branch.main.remote", "."]);
    assert_eq!(branch_push_remote(repo.path(), "main"), ".");
    assert_eq!(head_push_remote(repo.path()), ".");
}

#[test]
fn publish_remote_splits_on_longest_configured_remote() {
    let repo = TempRepo::new("publish-remote-split");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["remote", "add", "origin", "https://example.test/a.git"]);
    // git permits a slash in a remote name; configure via config keys so the
    // test doesn't depend on `git remote add` accepting it.
    repo.git_ok(&[
        "config",
        "remote.origin/x.url",
        "https://example.test/b.git",
    ]);
    repo.git_ok(&[
        "config",
        "remote.origin/x.fetch",
        "+refs/heads/*:refs/remotes/origin/x/*",
    ]);

    assert_eq!(
        publish_remote(repo.path(), "origin/x/feature").expect("split"),
        "origin/x",
        "the longest configured remote name must win"
    );
    assert_eq!(
        publish_remote(repo.path(), "origin/feature").expect("split"),
        "origin"
    );
    assert!(publish_remote(repo.path(), "no-slash").is_err());
}
