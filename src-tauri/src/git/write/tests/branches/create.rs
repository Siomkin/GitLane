//! Creating a branch and setting its upstream.

use super::super::support::*;

#[test]
fn create_branch_from_a_remote_tracking_ref_keeps_upstream_setup() {
    let (repo, base) = repo_with_base_commit("create-branch-tracking");
    repo.git_ok(&["update-ref", "refs/remotes/origin/topic", &base]);

    create_branch(repo.path(), "topic", "refs/remotes/origin/topic", &base)
        .expect("create branch from a remote-tracking start point");

    assert_eq!(rev_parse(&repo, "refs/heads/topic"), base);
    // Passing the ref (not its oid) lets `branch.autoSetupMerge` wire tracking.
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["config", "branch.topic.remote"]).stdout).trim(),
        "origin"
    );
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["config", "branch.topic.merge"]).stdout).trim(),
        "refs/heads/topic"
    );
}

#[test]
fn create_branch_from_a_differently_named_remote_does_not_track() {
    let (repo, base) = repo_with_base_commit("create-branch-no-track");
    repo.git_ok(&["update-ref", "refs/remotes/origin/develop", &base]);

    create_branch(
        repo.path(),
        "infra/deploy-bootstrap-seed",
        "refs/remotes/origin/develop",
        &base,
    )
    .expect("create a feature branch from origin/develop");

    assert_eq!(
        rev_parse(&repo, "refs/heads/infra/deploy-bootstrap-seed"),
        base
    );
    assert!(
        !repo
            .git(&[
                "config",
                "--get",
                "branch.infra/deploy-bootstrap-seed.remote"
            ])
            .status
            .success(),
        "a new name must not inherit origin/develop as upstream"
    );
}

#[test]
fn create_branch_from_a_nested_same_named_remote_still_tracks() {
    let (repo, base) = repo_with_base_commit("create-branch-nested-track");
    repo.git_ok(&["update-ref", "refs/remotes/origin/infra/topic", &base]);

    create_branch(
        repo.path(),
        "infra/topic",
        "refs/remotes/origin/infra/topic",
        &base,
    )
    .expect("create the local counterpart of origin/infra/topic");

    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["config", "branch.infra/topic.remote"]).stdout).trim(),
        "origin"
    );
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["config", "branch.infra/topic.merge"]).stdout).trim(),
        "refs/heads/infra/topic"
    );
}

#[test]
fn create_branch_rejects_a_stale_start_point() {
    let (repo, base) = repo_with_base_commit("create-branch-stale");
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "moved"]);

    assert!(
        create_branch(repo.path(), "pinned", "refs/heads/main", &base).is_err(),
        "a moved start point must fail closed"
    );
    assert!(
        repo.git(&["rev-parse", "--verify", "refs/heads/pinned"])
            .status
            .code()
            != Some(0),
        "no branch may be created from a stale snapshot"
    );
}

#[test]
fn set_upstream_writes_tracking_config() {
    let (repo, head) = repo_with_base_commit("set-upstream");
    // `--set-upstream-to` resolves the ref locally; seed it so no network is hit.
    repo.git(&["update-ref", "refs/remotes/origin/main", &head]);

    let result = set_upstream(repo.path(), "main", "origin/main");
    assert!(result.is_ok(), "set_upstream failed: {result:?}");

    let remote = String::from_utf8(repo.git(&["config", "branch.main.remote"]).stdout).unwrap();
    let merge = String::from_utf8(repo.git(&["config", "branch.main.merge"]).stdout).unwrap();
    assert_eq!(remote.trim(), "origin");
    assert_eq!(merge.trim(), "refs/heads/main");
}

#[test]
fn set_upstream_rejects_option_like_operands() {
    let repo = TempRepo::new("set-upstream-inj");
    repo.git(&["init", "-q"]);
    // Both operands flow into git unprefixed, so option-injection must fail
    // before the subprocess runs.
    assert!(set_upstream(repo.path(), "-D", "origin/main").is_err());
    assert!(set_upstream(repo.path(), "main", "--upload-pack=touch /tmp/x").is_err());
}

/// A new branch must not inherit the base it was started from as its upstream:
/// the push destination is built from `branch.<n>.merge`, so a feature that
/// tracks `develop` publishes *onto* develop and is never pushed under its own
/// name. `#418` fixed this for the fully-qualified spelling only.
#[test]
fn create_branch_from_the_short_remote_spelling_does_not_track_the_base() {
    let (_root, _seed, clone) = seed_and_clone("create-branch-short-remote");
    clone.git_ok(&["config", "user.name", "GitLane Test"]);
    clone.git_ok(&["config", "user.email", "gitlane@example.test"]);
    let base = rev_parse(&clone, "refs/remotes/origin/main");

    create_branch(clone.path(), "feat", "origin/main", &base).expect("create the branch");

    let config = clone.git(&["config", "--get-regexp", "^branch\\.feat\\."]);
    assert!(
        String::from_utf8_lossy(&config.stdout).trim().is_empty(),
        "a differently-named base must not become the upstream: {}",
        String::from_utf8_lossy(&config.stdout)
    );
}

/// The guard must stay narrow: a same-named counterpart is exactly the case
/// git's automatic upstream setup exists for.
#[test]
fn create_branch_from_its_same_named_counterpart_still_tracks() {
    let (_root, seed, clone) = seed_and_clone("create-branch-same-named");
    clone.git_ok(&["config", "user.name", "GitLane Test"]);
    clone.git_ok(&["config", "user.email", "gitlane@example.test"]);
    seed.git_ok(&["branch", "topic"]);
    clone.git_ok(&["fetch", "-q"]);
    let base = rev_parse(&clone, "refs/remotes/origin/topic");

    create_branch(clone.path(), "topic", "origin/topic", &base).expect("create the branch");

    let merge = clone.git(&["config", "--get", "branch.topic.merge"]);
    assert_eq!(
        String::from_utf8_lossy(&merge.stdout).trim(),
        "refs/heads/topic",
        "a same-named counterpart is still tracked"
    );
}

/// The same rule for the sibling path that creates a branch and a worktree in
/// one step — it had no guard at all.
#[test]
fn add_worktree_with_a_new_branch_does_not_track_a_differently_named_base() {
    let (root, _seed, clone) = seed_and_clone("worktree-new-branch-upstream");
    clone.git_ok(&["config", "user.name", "GitLane Test"]);
    clone.git_ok(&["config", "user.email", "gitlane@example.test"]);
    let path = root.0.join("wt");

    add_worktree(
        clone.path(),
        path.to_str().unwrap(),
        Some("refs/remotes/origin/main"),
        Some("feat"),
    )
    .expect("create the worktree and its branch");

    let config = clone.git(&["config", "--get-regexp", "^branch\\.feat\\."]);
    assert!(
        String::from_utf8_lossy(&config.stdout).trim().is_empty(),
        "the new branch must not track the base: {}",
        String::from_utf8_lossy(&config.stdout)
    );
}
