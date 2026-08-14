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
