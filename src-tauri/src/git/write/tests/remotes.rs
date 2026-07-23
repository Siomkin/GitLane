//! `remotes` write-path tests.

use super::support::*;

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
fn pull_branch_supports_a_local_tracking_upstream() {
    let (repo, base) = repo_with_base_commit("pull-local-upstream");
    repo.git_ok(&["branch", "feature"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "main ahead"]);
    let main_tip = rev_parse(&repo, "main");
    repo.git_ok(&["checkout", "-q", "feature"]);
    repo.git_ok(&["config", "branch.feature.remote", "."]);
    repo.git_ok(&["config", "branch.feature.merge", "refs/heads/main"]);

    pull_branch(
        repo.path(),
        "feature",
        &base,
        ".",
        "refs/heads/main",
        &TransportCredential::None,
    )
    .expect("pull from local upstream");

    assert_eq!(rev_parse(&repo, "feature"), main_tip);
}

#[test]
fn force_push_to_local_upstream_leases_existing_and_missing_destinations() {
    let (repo, _) = repo_with_base_commit("force-push-local-upstream");
    repo.git_ok(&["branch", "feature"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "main ahead"]);
    let previous_main = rev_parse(&repo, "main");
    repo.git_ok(&["checkout", "-q", "feature"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "rewritten feature"]);
    let feature_tip = rev_parse(&repo, "feature");
    repo.git_ok(&["config", "branch.feature.remote", "."]);
    repo.git_ok(&["config", "branch.feature.merge", "refs/heads/main"]);
    let first_preview = preview_force_push(repo.path(), "feature").expect("first preview");

    force_push(
        repo.path(),
        "feature",
        &first_preview.expected_oid,
        &ForcePushRouteLease::from(&first_preview),
        &TransportCredential::None,
    )
    .expect("explicit local lease should replace the observed destination");
    assert_ne!(previous_main, feature_tip);
    assert_eq!(rev_parse(&repo, "main"), feature_tip);

    repo.git_ok(&["config", "branch.feature.merge", "refs/heads/local-copy"]);
    assert!(!repo
        .git(&["show-ref", "--verify", "refs/heads/local-copy"])
        .status
        .success());
    let second_preview = preview_force_push(repo.path(), "feature").expect("second preview");
    force_push(
        repo.path(),
        "feature",
        &second_preview.expected_oid,
        &ForcePushRouteLease::from(&second_preview),
        &TransportCredential::None,
    )
    .expect("an empty lease should require and preserve destination nonexistence");
    assert_eq!(rev_parse(&repo, "local-copy"), feature_tip);
}

#[test]
fn force_push_rejects_a_server_advance_even_after_tracking_catches_up() {
    let remote = TempRepo::new("force-push-preview-lease-remote");
    remote.git_ok(&["init", "-q", "--bare"]);

    let (seed, base) = repo_with_base_commit("force-push-preview-lease-seed");
    seed.git_ok(&["remote", "set-url", "origin", remote.path()]);
    seed.git_ok(&["push", "-q", "-u", "origin", "main"]);

    let client = TempRepo::new("force-push-preview-lease-client");
    client.git_ok(&["clone", "-q", "--branch", "main", remote.path(), "."]);
    client.git_ok(&["config", "user.email", "client@example.test"]);
    client.git_ok(&["config", "user.name", "Client"]);
    client.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(client.0.join("f.txt"), b"local rewrite\n").unwrap();
    client.git_ok(&["commit", "-q", "-am", "local rewrite"]);
    let preview = preview_force_push(client.path(), "main").expect("preview");
    assert_eq!(preview.destination_oid.as_deref(), Some(base.as_str()));

    std::fs::write(seed.0.join("f.txt"), b"teammate advance\n").unwrap();
    seed.git_ok(&["commit", "-q", "-am", "teammate advance"]);
    seed.git_ok(&["push", "-q", "origin", "main"]);
    let teammate_tip = rev_parse(&seed, "main");
    client.git_ok(&["fetch", "-q", "origin"]);
    assert_eq!(
        rev_parse(&client, "refs/remotes/origin/main"),
        teammate_tip,
        "the live tracking ref must be newer than the previewed lease"
    );

    let result = force_push(
        client.path(),
        "main",
        &preview.expected_oid,
        &ForcePushRouteLease::from(&preview),
        &TransportCredential::None,
    );
    assert!(
        result.is_err(),
        "the previewed lease must reject the advance"
    );
    assert_eq!(
        rev_parse(&remote, "refs/heads/main"),
        teammate_tip,
        "the teammate's server-side tip must not be overwritten"
    );
}

#[test]
fn force_push_absent_destination_lease_rejects_an_existing_server_branch() {
    let remote = TempRepo::new("force-push-absent-lease-remote");
    remote.git_ok(&["init", "-q", "--bare"]);
    let (seed, server_tip) = repo_with_base_commit("force-push-absent-lease-seed");
    seed.git_ok(&["remote", "set-url", "origin", remote.path()]);
    seed.git_ok(&["push", "-q", "origin", "main"]);

    let (client, _) = repo_with_base_commit("force-push-absent-lease-client");
    client.git_ok(&["remote", "set-url", "origin", remote.path()]);
    client.git_ok(&["config", "branch.main.remote", "origin"]);
    client.git_ok(&["config", "branch.main.merge", "refs/heads/main"]);
    client.git_ok(&["commit", "-q", "--allow-empty", "-m", "client rewrite"]);
    assert!(!client
        .git(&["show-ref", "--verify", "refs/remotes/origin/main"])
        .status
        .success());
    let preview = preview_force_push(client.path(), "main").expect("preview");
    assert_eq!(preview.destination_oid, None);

    let result = force_push(
        client.path(),
        "main",
        &preview.expected_oid,
        &ForcePushRouteLease::from(&preview),
        &TransportCredential::None,
    );

    assert!(
        result.is_err(),
        "a null lease must require the server destination to remain absent"
    );
    assert_eq!(rev_parse(&remote, "refs/heads/main"), server_tip);
}

#[test]
fn force_push_preview_uses_the_triangular_push_destination() {
    let (repo, base) = repo_with_base_commit("force-push-preview-triangular");
    repo.git_ok(&[
        "remote",
        "add",
        "upstream",
        "https://example.test/upstream.git",
    ]);
    repo.git_ok(&["remote", "add", "fork", "https://example.test/fork.git"]);
    repo.git_ok(&["config", "branch.main.remote", "upstream"]);
    repo.git_ok(&["config", "branch.main.merge", "refs/heads/review"]);
    repo.git_ok(&["config", "branch.main.pushRemote", "fork"]);
    repo.git_ok(&["update-ref", "refs/remotes/fork/main", &base]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "local work"]);
    let local_tip = rev_parse(&repo, "main");
    repo.git_ok(&["update-ref", "refs/remotes/upstream/review", &local_tip]);

    let preview = preview_force_push(repo.path(), "main").expect("preview");

    assert_eq!(preview.expected_oid, local_tip);
    assert_eq!(preview.remote, "fork");
    assert_eq!(preview.destination_ref, "refs/heads/main");
    assert_eq!(preview.destination_oid.as_deref(), Some(base.as_str()));
    assert!(preview
        .details
        .iter()
        .any(|line| line.contains("fork/main")));
    assert!(!preview
        .details
        .iter()
        .any(|line| line.contains("upstream/review")));
}

#[test]
fn force_push_rejects_endpoint_url_drift_after_preview() {
    let first_remote = TempRepo::new("force-push-endpoint-first");
    first_remote.git_ok(&["init", "-q", "--bare"]);
    let second_remote = TempRepo::new("force-push-endpoint-second");
    second_remote.git_ok(&["init", "-q", "--bare"]);
    let (repo, _) = repo_with_base_commit("force-push-endpoint-client");
    repo.git_ok(&["remote", "set-url", "origin", first_remote.path()]);
    repo.git_ok(&["config", "branch.main.remote", "origin"]);
    repo.git_ok(&["config", "branch.main.merge", "refs/heads/main"]);
    let preview = preview_force_push(repo.path(), "main").expect("preview");

    repo.git_ok(&["remote", "set-url", "origin", second_remote.path()]);
    let error = force_push(
        repo.path(),
        "main",
        &preview.expected_oid,
        &ForcePushRouteLease::from(&preview),
        &TransportCredential::None,
    )
    .expect_err("a changed endpoint must invalidate the preview");

    assert!(error.contains("Push endpoint"), "unexpected error: {error}");
    assert!(!second_remote
        .git(&["show-ref", "--verify", "refs/heads/main"])
        .status
        .success());
}

#[test]
fn force_push_rejects_remote_and_destination_config_drift_before_transport() {
    let origin = TempRepo::new("force-push-route-drift-origin");
    origin.git_ok(&["init", "-q", "--bare"]);
    let fork = TempRepo::new("force-push-route-drift-fork");
    fork.git_ok(&["init", "-q", "--bare"]);
    let (repo, _) = repo_with_base_commit("force-push-route-drift-client");
    repo.git_ok(&["remote", "set-url", "origin", origin.path()]);
    repo.git_ok(&["remote", "add", "fork", fork.path()]);
    repo.git_ok(&["config", "branch.main.remote", "origin"]);
    repo.git_ok(&["config", "branch.main.merge", "refs/heads/main"]);

    let remote_preview = preview_force_push(repo.path(), "main").expect("remote preview");
    repo.git_ok(&["config", "branch.main.pushRemote", "fork"]);
    let remote_error = force_push(
        repo.path(),
        "main",
        &remote_preview.expected_oid,
        &ForcePushRouteLease::from(&remote_preview),
        &TransportCredential::None,
    )
    .expect_err("pushRemote drift must invalidate the preview");
    assert!(
        remote_error.contains("Push destination changed"),
        "unexpected error: {remote_error}"
    );

    repo.git_ok(&["config", "--unset", "branch.main.pushRemote"]);
    let destination_preview = preview_force_push(repo.path(), "main").expect("destination preview");
    repo.git_ok(&["config", "branch.main.merge", "refs/heads/review"]);
    let destination_error = force_push(
        repo.path(),
        "main",
        &destination_preview.expected_oid,
        &ForcePushRouteLease::from(&destination_preview),
        &TransportCredential::None,
    )
    .expect_err("destination drift must invalidate the preview");
    assert!(
        destination_error.contains("Push destination changed"),
        "unexpected error: {destination_error}"
    );

    for endpoint in [&origin, &fork] {
        assert!(!endpoint
            .git(&["show-ref", "--verify", "refs/heads/main"])
            .status
            .success());
        assert!(!endpoint
            .git(&["show-ref", "--verify", "refs/heads/review"])
            .status
            .success());
    }
}

#[test]
fn force_push_keeps_the_named_remote_for_chained_url_rewrites() {
    let first_endpoint = TempRepo::new("force-push-rewrite-first");
    first_endpoint.git_ok(&["init", "-q", "--bare"]);
    let second_endpoint = TempRepo::new("force-push-rewrite-second");
    second_endpoint.git_ok(&["init", "-q", "--bare"]);
    let (repo, head) = repo_with_base_commit("force-push-rewrite-client");
    let alias = "gitlane-force-push-alias:";
    repo.git_ok(&["remote", "set-url", "origin", alias]);
    repo.git_ok(&["config", "branch.main.remote", "origin"]);
    repo.git_ok(&["config", "branch.main.merge", "refs/heads/main"]);
    repo.git_ok(&[
        "config",
        &format!("url.{}.pushInsteadOf", first_endpoint.path()),
        alias,
    ]);
    repo.git_ok(&[
        "config",
        &format!("url.{}.pushInsteadOf", second_endpoint.path()),
        first_endpoint.path(),
    ]);

    let preview = preview_force_push(repo.path(), "main").expect("preview");
    force_push(
        repo.path(),
        "main",
        &preview.expected_oid,
        &ForcePushRouteLease::from(&preview),
        &TransportCredential::None,
    )
    .expect("named remote should apply the rewrite exactly once");

    assert_eq!(rev_parse(&first_endpoint, "refs/heads/main"), head);
    assert!(!second_endpoint
        .git(&["show-ref", "--verify", "refs/heads/main"])
        .status
        .success());
}

#[test]
fn force_push_preview_rejects_multiple_push_urls() {
    let (repo, _) = repo_with_base_commit("force-push-multiple-endpoints");
    repo.git_ok(&[
        "config",
        "--add",
        "remote.origin.pushurl",
        "https://example.test/first.git",
    ]);
    repo.git_ok(&[
        "config",
        "--add",
        "remote.origin.pushurl",
        "https://example.test/second.git",
    ]);

    let error = preview_force_push(repo.path(), "main")
        .expect_err("a force-push must never fan out to multiple endpoints");

    assert!(
        error.contains("exactly one push URL"),
        "unexpected error: {error}"
    );
}

#[test]
fn force_push_rejects_a_local_dot_destination_outside_branch_refs() {
    let (repo, head) = repo_with_base_commit("force-push-local-tag-destination");
    repo.git_ok(&["tag", "-a", "v1", "-m", "annotated"]);
    let tag_object = rev_parse(&repo, "refs/tags/v1");
    assert_ne!(
        tag_object, head,
        "the regression requires an annotated tag object"
    );
    repo.git_ok(&["config", "branch.main.remote", "."]);
    repo.git_ok(&["config", "branch.main.merge", "refs/tags/v1"]);

    assert!(preview_force_push(repo.path(), "main").is_err());
    let endpoint_token = push_endpoint_token(repo.path(), ".").expect("local endpoint");
    let route = ForcePushRouteLease {
        remote: ".".to_string(),
        destination_ref: "refs/tags/v1".to_string(),
        destination_oid: Some(tag_object.clone()),
        push_endpoint_token: endpoint_token,
    };
    assert!(force_push(
        repo.path(),
        "main",
        &head,
        &route,
        &TransportCredential::None,
    )
    .is_err());
    assert_eq!(rev_parse(&repo, "refs/tags/v1"), tag_object);
}

#[test]
fn pull_target_reports_a_friendly_error_when_upstream_is_unset() {
    let (repo, _) = repo_with_base_commit("pull-no-upstream");

    let error = branch_pull_target(repo.path(), "main").expect_err("upstream must be required");

    assert_eq!(
        error,
        "Branch 'main' has no remote-tracking upstream. Publish it or set an upstream first."
    );
}

#[cfg(not(windows))]
#[test]
fn pull_branch_rejects_a_checkout_that_lands_during_fetch() {
    use std::os::unix::fs::PermissionsExt;

    let remote = TempRepo::new("pull-race-remote");
    remote.git_ok(&["init", "-q", "--bare"]);
    let seed = TempRepo::new("pull-race-seed");
    seed.git_ok(&["init", "-q", "-b", "main"]);
    seed.git_ok(&["config", "user.name", "GitLane Test"]);
    seed.git_ok(&["config", "user.email", "gitlane@example.test"]);
    seed.git_ok(&["config", "commit.gpgsign", "false"]);
    seed.git_ok(&["commit", "-q", "--allow-empty", "-m", "base"]);
    seed.git_ok(&["remote", "add", "origin", remote.path()]);
    seed.git_ok(&["push", "-q", "-u", "origin", "main"]);

    let client = TempRepo::new("pull-race-client");
    let clone = Command::new("git")
        .args(["clone", "-q", "-b", "main", remote.path(), client.path()])
        .output()
        .expect("git clone launches");
    assert!(
        clone.status.success(),
        "clone failed: {}",
        String::from_utf8_lossy(&clone.stderr)
    );
    client.git_ok(&["branch", "wrong"]);
    let original = rev_parse(&client, "main");

    seed.git_ok(&["commit", "-q", "--allow-empty", "-m", "remote ahead"]);
    seed.git_ok(&["push", "-q", "origin", "main"]);

    let marker = remote.0.join("fetch-started");
    let release = remote.0.join("allow-fetch");
    let helper = remote.0.join("slow-upload-pack.sh");
    std::fs::write(
        &helper,
        format!(
            "#!/bin/sh\ntouch '{}'\nattempt=0\nwhile [ ! -e '{}' ] && [ \"$attempt\" -lt 200 ]; do\n  attempt=$((attempt + 1))\n  sleep 0.05\ndone\nexec git-upload-pack \"$1\"\n",
            marker.display(),
            release.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755)).unwrap();
    client.git_ok(&[
        "config",
        "remote.origin.uploadpack",
        helper.to_str().unwrap(),
    ]);

    let path = client.path().to_string();
    let expected = original.clone();
    let pull = std::thread::spawn(move || {
        pull_branch(
            &path,
            "main",
            &expected,
            "origin",
            "refs/heads/main",
            &TransportCredential::None,
        )
    });
    for _ in 0..500 {
        if marker.exists() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    if !marker.exists() {
        let early = pull.join().expect("pull thread joins after early exit");
        panic!("the delayed fetch did not start; pull completed first: {early:?}");
    }
    client.git_ok(&["checkout", "-q", "wrong"]);
    std::fs::write(&release, b"").expect("release delayed fetch");

    let error = pull
        .join()
        .expect("pull thread joins")
        .expect_err("checkout must abort pull");
    assert!(error.contains("HEAD changed"), "unexpected error: {error}");
    assert_eq!(rev_parse(&client, "main"), original);
    assert_eq!(rev_parse(&client, "wrong"), original);
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
fn fetch_imports_remote_only_tags() {
    let root = TempRepo::new("fetch-tags-root");
    let origin = root.0.join("origin.git");
    let source = root.0.join("source");
    let clone = root.0.join("clone");

    Command::new("git")
        .args(["init", "--bare", "-q", origin.to_str().unwrap()])
        .output()
        .expect("git init bare launches");
    Command::new("git")
        .args(["init", "-q", source.to_str().unwrap()])
        .output()
        .expect("git init launches");

    let source_repo = TempRepo(source);
    source_repo.git_ok(&["config", "user.name", "GitLane Test"]);
    source_repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    source_repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(source_repo.0.join("file.txt"), b"v1\n").unwrap();
    source_repo.git_ok(&["add", "file.txt"]);
    source_repo.git_ok(&["commit", "-q", "-m", "initial"]);
    source_repo.git_ok(&["tag", "0.1.1"]);
    source_repo.git_ok(&["remote", "add", "origin", origin.to_str().unwrap()]);
    source_repo.git_ok(&["push", "-q", "origin", "HEAD:main"]);
    source_repo.git_ok(&["push", "-q", "origin", "refs/tags/0.1.1"]);
    let head_out = Command::new("git")
        .arg("-C")
        .arg(&origin)
        .args(["symbolic-ref", "HEAD", "refs/heads/main"])
        .output()
        .expect("git symbolic-ref launches");
    assert!(
        head_out.status.success(),
        "setting origin HEAD failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&head_out.stdout),
        String::from_utf8_lossy(&head_out.stderr),
    );

    let clone_out = Command::new("git")
        .args([
            "clone",
            "--no-tags",
            "-q",
            origin.to_str().unwrap(),
            clone.to_str().unwrap(),
        ])
        .output()
        .expect("git clone launches");
    assert!(
        clone_out.status.success(),
        "clone failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&clone_out.stdout),
        String::from_utf8_lossy(&clone_out.stderr),
    );
    let clone_repo = TempRepo(clone);
    let before = clone_repo.git(&["tag", "--list", "0.1.1"]);
    assert!(
        String::from_utf8_lossy(&before.stdout).trim().is_empty(),
        "test setup should start with the remote tag absent locally",
    );

    let result = fetch(clone_repo.path(), &std::collections::HashMap::new());
    assert!(result.is_ok(), "fetch failed: {result:?}");

    let after = clone_repo.git(&["tag", "--list", "0.1.1"]);
    assert_eq!(String::from_utf8_lossy(&after.stdout).trim(), "0.1.1");
}

#[test]
fn fetch_tag_import_honors_skip_fetch_all_remotes() {
    let root = TempRepo::new("fetch-skip-remote-root");
    let origin = root.0.join("origin.git");
    let source = root.0.join("source");
    let clone = root.0.join("clone");
    let unreachable = root.0.join("missing.git");
    let also_unreachable = root.0.join("also-missing.git");

    Command::new("git")
        .args(["init", "--bare", "-q", origin.to_str().unwrap()])
        .output()
        .expect("git init bare launches");
    Command::new("git")
        .args(["init", "-q", source.to_str().unwrap()])
        .output()
        .expect("git init launches");

    let source_repo = TempRepo(source);
    source_repo.git_ok(&["config", "user.name", "GitLane Test"]);
    source_repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    source_repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(source_repo.0.join("file.txt"), b"v1\n").unwrap();
    source_repo.git_ok(&["add", "file.txt"]);
    source_repo.git_ok(&["commit", "-q", "-m", "initial"]);
    source_repo.git_ok(&["tag", "0.1.1"]);
    source_repo.git_ok(&["remote", "add", "origin", origin.to_str().unwrap()]);
    source_repo.git_ok(&["push", "-q", "origin", "HEAD:main"]);
    source_repo.git_ok(&["push", "-q", "origin", "refs/tags/0.1.1"]);
    let head_out = Command::new("git")
        .arg("-C")
        .arg(&origin)
        .args(["symbolic-ref", "HEAD", "refs/heads/main"])
        .output()
        .expect("git symbolic-ref launches");
    assert!(head_out.status.success(), "setting origin HEAD failed");

    let clone_out = Command::new("git")
        .args([
            "clone",
            "--no-tags",
            "-q",
            origin.to_str().unwrap(),
            clone.to_str().unwrap(),
        ])
        .output()
        .expect("git clone launches");
    assert!(clone_out.status.success(), "clone failed");
    let clone_repo = TempRepo(clone);
    clone_repo.git_ok(&["remote", "add", "backup", unreachable.to_str().unwrap()]);
    clone_repo.git_ok(&["config", "remote.backup.skipFetchAll", "true"]);
    clone_repo.git_ok(&[
        "remote",
        "add",
        "archive",
        also_unreachable.to_str().unwrap(),
    ]);
    clone_repo.git_ok(&["config", "remote.archive.skipDefaultUpdate", "true"]);

    let result = fetch(clone_repo.path(), &std::collections::HashMap::new());
    assert!(
        result.is_ok(),
        "skipped unreachable remote should not fail tag import: {result:?}",
    );

    let after = clone_repo.git(&["tag", "--list", "0.1.1"]);
    assert_eq!(String::from_utf8_lossy(&after.stdout).trim(), "0.1.1");
}

#[test]
fn fetch_preserves_local_only_tags_under_fetch_prune() {
    let root = TempRepo::new("fetch-prune-local-tag-root");
    let origin = root.0.join("origin.git");
    let source = root.0.join("source");
    let clone = root.0.join("clone");

    Command::new("git")
        .args(["init", "--bare", "-q", origin.to_str().unwrap()])
        .output()
        .expect("git init bare launches");
    Command::new("git")
        .args(["init", "-q", source.to_str().unwrap()])
        .output()
        .expect("git init launches");

    let source_repo = TempRepo(source);
    source_repo.git_ok(&["config", "user.name", "GitLane Test"]);
    source_repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    source_repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(source_repo.0.join("file.txt"), b"v1\n").unwrap();
    source_repo.git_ok(&["add", "file.txt"]);
    source_repo.git_ok(&["commit", "-q", "-m", "initial"]);
    source_repo.git_ok(&["tag", "0.1.1"]);
    source_repo.git_ok(&["remote", "add", "origin", origin.to_str().unwrap()]);
    source_repo.git_ok(&["push", "-q", "origin", "HEAD:main"]);
    source_repo.git_ok(&["push", "-q", "origin", "refs/tags/0.1.1"]);
    let head_out = Command::new("git")
        .arg("-C")
        .arg(&origin)
        .args(["symbolic-ref", "HEAD", "refs/heads/main"])
        .output()
        .expect("git symbolic-ref launches");
    assert!(head_out.status.success(), "setting origin HEAD failed");

    let clone_out = Command::new("git")
        .args([
            "clone",
            "--no-tags",
            "-q",
            origin.to_str().unwrap(),
            clone.to_str().unwrap(),
        ])
        .output()
        .expect("git clone launches");
    assert!(clone_out.status.success(), "clone failed");
    let clone_repo = TempRepo(clone);
    // Pruning on + a local-only tag is the exact combination that the
    // explicit tag refspec would delete without `--no-prune`.
    clone_repo.git_ok(&["config", "fetch.prune", "true"]);
    clone_repo.git_ok(&["tag", "keep-me", "HEAD"]);

    let result = fetch(clone_repo.path(), &std::collections::HashMap::new());
    assert!(result.is_ok(), "fetch failed: {result:?}");

    let local_only = clone_repo.git(&["tag", "--list", "keep-me"]);
    assert_eq!(
        String::from_utf8_lossy(&local_only.stdout).trim(),
        "keep-me",
        "a local-only tag must survive Fetch under fetch.prune=true",
    );
    // The remote tag must still import — preservation can't come at the cost
    // of the feature.
    let imported = clone_repo.git(&["tag", "--list", "0.1.1"]);
    assert_eq!(String::from_utf8_lossy(&imported.stdout).trim(), "0.1.1");
}

#[test]
fn fetch_ignores_tag_clobber_rejection_after_branch_updates() {
    let root = TempRepo::new("fetch-tag-clobber-root");
    let origin = root.0.join("origin.git");
    let source = root.0.join("source");
    let clone = root.0.join("clone");

    Command::new("git")
        .args(["init", "--bare", "-q", origin.to_str().unwrap()])
        .output()
        .expect("git init bare launches");
    Command::new("git")
        .args(["init", "-q", source.to_str().unwrap()])
        .output()
        .expect("git init launches");

    let source_repo = TempRepo(source);
    source_repo.git_ok(&["config", "user.name", "GitLane Test"]);
    source_repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    source_repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(source_repo.0.join("file.txt"), b"v1\n").unwrap();
    source_repo.git_ok(&["add", "file.txt"]);
    source_repo.git_ok(&["commit", "-q", "-m", "initial"]);
    source_repo.git_ok(&["tag", "0.1.1"]);
    source_repo.git_ok(&["remote", "add", "origin", origin.to_str().unwrap()]);
    source_repo.git_ok(&["push", "-q", "origin", "HEAD:main"]);
    source_repo.git_ok(&["push", "-q", "origin", "refs/tags/0.1.1"]);
    let head_out = Command::new("git")
        .arg("-C")
        .arg(&origin)
        .args(["symbolic-ref", "HEAD", "refs/heads/main"])
        .output()
        .expect("git symbolic-ref launches");
    assert!(head_out.status.success(), "setting origin HEAD failed");

    let clone_out = Command::new("git")
        .args([
            "clone",
            "--no-tags",
            "-q",
            origin.to_str().unwrap(),
            clone.to_str().unwrap(),
        ])
        .output()
        .expect("git clone launches");
    assert!(clone_out.status.success(), "clone failed");
    let clone_repo = TempRepo(clone);
    clone_repo.git_ok(&["config", "user.name", "GitLane Test"]);
    clone_repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    clone_repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(clone_repo.0.join("local.txt"), b"local\n").unwrap();
    clone_repo.git_ok(&["add", "local.txt"]);
    clone_repo.git_ok(&["commit", "-q", "-m", "local diverging tag target"]);
    clone_repo.git_ok(&["tag", "0.1.1"]);
    let local_tag = clone_repo.git(&["rev-parse", "refs/tags/0.1.1"]);
    let local_tag_oid = String::from_utf8_lossy(&local_tag.stdout)
        .trim()
        .to_string();

    std::fs::write(source_repo.0.join("file.txt"), b"v2\n").unwrap();
    source_repo.git_ok(&["commit", "-qam", "remote update"]);
    source_repo.git_ok(&["tag", "-f", "0.1.1"]);
    source_repo.git_ok(&["push", "-q", "origin", "HEAD:main"]);
    source_repo.git_ok(&["push", "-q", "--force", "origin", "refs/tags/0.1.1"]);
    let remote_tip = source_repo.git(&["rev-parse", "HEAD"]);
    let remote_tip_oid = String::from_utf8_lossy(&remote_tip.stdout)
        .trim()
        .to_string();

    let result = fetch(clone_repo.path(), &std::collections::HashMap::new());
    assert!(
        result.is_ok(),
        "tag clobber rejection should not fail fetch: {result:?}"
    );

    let fetched_origin = clone_repo.git(&["rev-parse", "refs/remotes/origin/main"]);
    assert_eq!(
        String::from_utf8_lossy(&fetched_origin.stdout).trim(),
        remote_tip_oid,
        "branch updates should still be visible after the tolerated tag rejection",
    );
    let after_tag = clone_repo.git(&["rev-parse", "refs/tags/0.1.1"]);
    assert_eq!(
        String::from_utf8_lossy(&after_tag.stdout).trim(),
        local_tag_oid,
        "conflicting local tag should not be clobbered",
    );
}

#[test]
fn tag_clobber_detection_does_not_mask_real_fetch_errors() {
    assert!(is_tag_clobber_rejection(
        "From /tmp/origin\n ! [rejected] 0.1.1 -> 0.1.1 (would clobber existing tag)"
    ));
    assert!(!is_tag_clobber_rejection(
        "fatal: unable to access remote\n ! [rejected] 0.1.1 -> 0.1.1 (would clobber existing tag)"
    ));
    assert!(!is_tag_clobber_rejection(
        "error: could not fetch origin\n ! [rejected] 0.1.1 -> 0.1.1 (would clobber existing tag)"
    ));
}

#[test]
fn concurrent_fetch_ref_update_detection_is_narrow() {
    assert!(is_concurrent_fetch_ref_update(
        "error: cannot lock ref 'refs/remotes/origin/latest': is at ed578d30 but expected 857461bc\n ! 857461bc..ed578d30 latest -> origin/latest (unable to update local ref)"
    ));
    assert!(!is_concurrent_fetch_ref_update(
        "error: cannot lock ref 'refs/remotes/origin/latest': Unable to create '/repo/.git/refs/remotes/origin/latest.lock': File exists."
    ));
    assert!(!is_concurrent_fetch_ref_update(
        "fatal: Authentication failed for 'https://github.com/o/r.git/'"
    ));
}

#[test]
fn force_push_preview_fails_closed_for_missing_branch() {
    let (repo, _) = repo_with_base_commit("force-push-missing");
    assert!(preview_force_push(repo.path(), "no-such-branch").is_err());
}

#[test]
fn force_push_preview_reports_local_divergence() {
    let (repo, base) = repo_with_base_commit("force-push-preview");
    // Configure upstream and seed a remote-tracking ref at the base commit so
    // the local branch is one commit ahead — all resolved offline.
    repo.git(&["config", "branch.main.remote", "origin"]);
    repo.git(&["config", "branch.main.merge", "refs/heads/main"]);
    repo.git(&["update-ref", "refs/remotes/origin/main", &base]);
    std::fs::write(repo.0.join("f.txt"), b"local\n").unwrap();
    repo.git(&["commit", "-qam", "local-work"]);

    let preview = preview_force_push(repo.path(), "main").expect("preview");
    assert!(preview.summary.contains("main"));
    assert!(preview
        .details
        .iter()
        .any(|line| line.contains("local-work")));
    assert!(preview
        .warnings
        .iter()
        .any(|line| line.contains("force-with-lease")));
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

#[test]
fn pull_stays_ff_only_under_pull_rebase_config() {
    let (_root, seed, clone) = seed_and_clone("pull-rebase");
    clone.git_ok(&["config", "user.name", "GitLane Test"]);
    clone.git_ok(&["config", "user.email", "gitlane@example.test"]);
    clone.git_ok(&["config", "commit.gpgsign", "false"]);
    // `pull.rebase=true` would make an unpinned pull rebase on divergence; the
    // `--no-rebase --ff-only` contract must fail instead of rebasing.
    clone.git_ok(&["config", "pull.rebase", "true"]);

    // Diverge: one new commit in the seed, a different one in the clone.
    std::fs::write(seed.0.join("file.txt"), b"seed-side\n").unwrap();
    seed.git_ok(&["add", "file.txt"]);
    seed.git_ok(&["commit", "-q", "-m", "seed diverge"]);

    std::fs::write(clone.0.join("other.txt"), b"clone-side\n").unwrap();
    clone.git_ok(&["add", "other.txt"]);
    clone.git_ok(&["commit", "-q", "-m", "clone diverge"]);

    let before = clone.git(&["rev-parse", "HEAD"]);
    let before_head = String::from_utf8_lossy(&before.stdout).trim().to_string();

    let result = pull(clone.path(), &TransportCredential::None);
    assert!(result.is_err(), "divergent pull must fail, got {result:?}");

    // No rebase and no merge happened: the clone HEAD is untouched.
    let after = clone.git(&["rev-parse", "HEAD"]);
    let after_head = String::from_utf8_lossy(&after.stdout).trim().to_string();
    assert_eq!(
        before_head, after_head,
        "HEAD must be unchanged after a failed pull"
    );
}

#[test]
fn pull_fast_forwards_when_behind() {
    let (_root, seed, clone) = seed_and_clone("pull-ff");

    // Advance the seed after cloning, so the clone is strictly behind.
    std::fs::write(seed.0.join("file.txt"), b"v2\n").unwrap();
    seed.git_ok(&["add", "file.txt"]);
    seed.git_ok(&["commit", "-q", "-m", "seed advance"]);
    let seed_head = String::from_utf8_lossy(&seed.git(&["rev-parse", "HEAD"]).stdout)
        .trim()
        .to_string();

    pull(clone.path(), &TransportCredential::None).expect("fast-forward pull when strictly behind");

    let clone_head = String::from_utf8_lossy(&clone.git(&["rev-parse", "HEAD"]).stdout)
        .trim()
        .to_string();
    assert_eq!(
        clone_head, seed_head,
        "clone HEAD fast-forwarded to seed HEAD"
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
fn fetch_continues_past_a_failing_remote_and_labels_the_output() {
    let root = TempRepo::new("fetch-multi-remote");
    let origin = root.0.join("origin.git");
    let source = root.0.join("source");
    let clone = root.0.join("clone");

    Command::new("git")
        .args(["init", "--bare", "-q", origin.to_str().unwrap()])
        .output()
        .expect("git init bare launches");
    Command::new("git")
        .args(["init", "-q", source.to_str().unwrap()])
        .output()
        .expect("git init launches");

    let source_repo = TempRepo(source);
    source_repo.git_ok(&["config", "user.name", "GitLane Test"]);
    source_repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    source_repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(source_repo.0.join("file.txt"), b"v1\n").unwrap();
    source_repo.git_ok(&["add", "file.txt"]);
    source_repo.git_ok(&["commit", "-q", "-m", "initial"]);
    source_repo.git_ok(&["remote", "add", "origin", origin.to_str().unwrap()]);
    source_repo.git_ok(&["push", "-q", "origin", "HEAD:main"]);

    let clone_out = Command::new("git")
        .args([
            "clone",
            "-q",
            origin.to_str().unwrap(),
            clone.to_str().unwrap(),
        ])
        .output()
        .expect("git clone launches");
    assert!(clone_out.status.success(), "clone failed");
    let clone_repo = TempRepo(clone);
    clone_repo.git_ok(&[
        "remote",
        "add",
        "broken",
        root.0.join("missing.git").to_str().unwrap(),
    ]);

    // Advance origin so the reachable remote has something to fetch.
    std::fs::write(source_repo.0.join("file.txt"), b"v2\n").unwrap();
    source_repo.git_ok(&["add", "file.txt"]);
    source_repo.git_ok(&["commit", "-q", "-m", "second"]);
    source_repo.git_ok(&["push", "-q", "origin", "HEAD:main"]);

    let err = fetch(clone_repo.path(), &std::collections::HashMap::new())
        .expect_err("an unreachable remote must fail the fetch overall");
    assert!(
        err.contains("broken"),
        "the error should name the failing remote:\n{err}"
    );

    // The reachable remote was still fetched despite the failure.
    let fetched = rev_parse(&clone_repo, "refs/remotes/origin/main");
    let expected = rev_parse(&source_repo, "HEAD");
    assert_eq!(
        fetched, expected,
        "origin must be up to date even though 'broken' failed"
    );
}
