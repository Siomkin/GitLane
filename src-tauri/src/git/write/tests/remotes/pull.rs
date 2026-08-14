//! Pull: upstream resolution, fast-forward behaviour, and the checkout races
//! it has to refuse.

use super::super::support::*;

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
