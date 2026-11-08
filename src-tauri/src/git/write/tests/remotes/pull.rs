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

/// Pull `main` in `clone` the way the `pull` command does: resolve the
/// configured upstream, then fetch and fast-forward from the tip seen now.
fn pull_main(clone: &TempRepo) -> Result<String, String> {
    let head = rev_parse(clone, "main");
    let (remote, merge_ref) =
        branch_pull_target(clone.path(), "main").expect("the clone tracks origin/main");
    pull_branch(
        clone.path(),
        "main",
        &head,
        &remote,
        &merge_ref,
        &TransportCredential::None,
    )
}

#[test]
fn pull_stays_ff_only_under_pull_rebase_config() {
    let (_root, seed, clone) = seed_and_clone("pull-rebase");
    clone.git_ok(&["config", "user.name", "GitLane Test"]);
    clone.git_ok(&["config", "user.email", "gitlane@example.test"]);
    clone.git_ok(&["config", "commit.gpgsign", "false"]);
    // `pull.rebase=true` makes a plain `git pull` rebase on divergence; the
    // ff-only contract (GL-113) must fail instead of rebasing or merging.
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

    let result = pull_main(&clone);
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

    pull_main(&clone).expect("fast-forward pull when strictly behind");

    let clone_head = String::from_utf8_lossy(&clone.git(&["rev-parse", "HEAD"]).stdout)
        .trim()
        .to_string();
    assert_eq!(
        clone_head, seed_head,
        "clone HEAD fast-forwarded to seed HEAD"
    );
}

/// Another fetch rewrites `FETCH_HEAD` while the pull waits for the index lock.
#[test]
fn pull_ignores_a_fetch_head_rewritten_while_it_waits_for_the_lock() {
    let (_root, seed, clone) = seed_and_clone("pull-oid-race");
    seed.git_ok(&["commit", "-q", "--allow-empty", "-m", "seed advance"]);
    let seed_head = rev_parse(&seed, "HEAD");
    let other = rev_parse(&clone, "HEAD");
    let fetch_head = clone.0.join(".git/FETCH_HEAD");
    let held = crate::git::write::index_lock::lock_index_writes(clone.path()).unwrap();

    let result = std::thread::scope(|scope| {
        let pull = scope.spawn(|| pull_main(&clone));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let recorded = loop {
            let text = std::fs::read_to_string(&fetch_head).unwrap_or_default();
            if text.contains("branch 'main' of ") {
                break text;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the fetch never landed"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        std::fs::write(
            &fetch_head,
            format!("{other}\t\ttag 'v9' of elsewhere\n{recorded}"),
        )
        .unwrap();
        drop(held);
        pull.join().unwrap()
    });

    result.expect("pull by the captured commit");
    assert_eq!(rev_parse(&clone, "HEAD"), seed_head);
}

#[test]
fn pull_accepts_a_short_ref_name_and_a_ref_outside_heads() {
    let (_root, seed, clone) = seed_and_clone("pull-ref-shapes");
    seed.git_ok(&["commit", "-q", "--allow-empty", "-m", "first"]);
    let first = rev_parse(&seed, "HEAD");
    let head = rev_parse(&clone, "main");
    let pull = |merge_ref: &str, expected: &str| {
        pull_branch(
            clone.path(),
            "main",
            expected,
            "origin",
            merge_ref,
            &TransportCredential::None,
        )
    };
    pull("main", &head).expect("pull by short name");
    assert_eq!(rev_parse(&clone, "main"), first);

    seed.git_ok(&["commit", "-q", "--allow-empty", "-m", "second"]);
    let second = rev_parse(&seed, "HEAD");
    seed.git_ok(&["update-ref", "refs/pull/1/head", &second]);
    pull("refs/pull/1/head", &first).expect("pull a pull-request ref");
    assert_eq!(rev_parse(&clone, "main"), second);

    seed.git_ok(&["commit", "-q", "--allow-empty", "-m", "third"]);
    let third = rev_parse(&seed, "HEAD");
    seed.git_ok(&["update-ref", "refs/pull/2/head", &third]);
    pull("pull/2/head", &second).expect("pull a short non-branch ref");
    assert_eq!(rev_parse(&clone, "main"), third);

    seed.git_ok(&["commit", "-q", "--allow-empty", "-m", "fourth"]);
    let fourth = rev_parse(&seed, "HEAD");
    seed.git_ok(&["tag", "v1", &fourth]);
    pull("refs/tags/v1", &third).expect("pull a tag ref");
    assert_eq!(rev_parse(&clone, "main"), fourth);

    seed.git_ok(&["commit", "-q", "--allow-empty", "-m", "fifth"]);
    let fifth = rev_parse(&seed, "HEAD");
    pull("HEAD", &fourth).expect("pull the remote's HEAD");
    assert_eq!(rev_parse(&clone, "main"), fifth);
}

#[test]
fn pull_accepts_a_local_remote_tracking_upstream() {
    let (repo, base) = repo_with_base_commit("pull-remote-tracking");
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "ahead"]);
    let ahead = rev_parse(&repo, "main");
    repo.git_ok(&["update-ref", "refs/remotes/origin/main", &ahead]);
    repo.git_ok(&["checkout", "-q", "-b", "feature", &base]);

    pull_branch(
        repo.path(),
        "feature",
        &base,
        ".",
        "refs/remotes/origin/main",
        &TransportCredential::None,
    )
    .expect("pull a remote-tracking upstream");

    assert_eq!(rev_parse(&repo, "feature"), ahead);
}

#[test]
fn pull_in_a_linked_worktree_reads_its_own_fetch_head() {
    let (root, seed, clone) = seed_and_clone("pull-linked");
    let linked = root.0.join("linked");
    let at = linked.to_str().unwrap();
    let base = rev_parse(&clone, "main");
    clone.git_ok(&["worktree", "add", "-q", "-b", "side", at, "main"]);
    seed.git_ok(&["commit", "-q", "--allow-empty", "-m", "seed advance"]);
    let seed_head = rev_parse(&seed, "HEAD");

    pull_branch(
        at,
        "side",
        &base,
        "origin",
        "refs/heads/main",
        &TransportCredential::None,
    )
    .expect("pull in a linked worktree");

    assert_eq!(rev_parse(&clone, "side"), seed_head);
    assert!(!clone.0.join(".git/FETCH_HEAD").exists());
}

#[test]
fn a_pull_names_itself_in_the_reflog() {
    let (_root, seed, clone) = seed_and_clone("pull-reflog");
    seed.git_ok(&["commit", "-q", "--allow-empty", "-m", "seed advance"]);

    pull_main(&clone).expect("pull");

    let subject = clone.git(&["log", "-g", "-1", "--format=%gs", "main"]);
    assert_eq!(
        String::from_utf8_lossy(&subject.stdout).trim(),
        "pull refs/heads/main: Fast-forward"
    );
}
