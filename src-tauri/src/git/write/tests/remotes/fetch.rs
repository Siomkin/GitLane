//! Fetch itself: concurrent ref-update detection, and continuing past a
//! failing remote with the output labelled per remote.

use super::super::support::*;

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
