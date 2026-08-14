//! Force-push leasing: what the preview captures and every drift that must
//! stop the transport.

use super::super::support::*;

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
