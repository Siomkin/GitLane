//! Squash and the pre-staged index: what is excluded, what is restored, and
//! when a restore is refused.

use super::super::support::*;

#[test]
fn squash_excludes_pre_staged_work_and_keeps_it_staged() {
    // GL-307: soft-reset + commit used to swallow unrelated pre-staged WIP into
    // the squash commit. The squash-owned tree must equal the pre-squash tip;
    // pre-staged work stays staged afterward.
    let (repo, base, tip) = tip_range_for_squash("squash-prestaged-mod");
    let tip_tree = rev_parse(&repo, "HEAD^{tree}");

    std::fs::write(repo.0.join("wip.txt"), "staged\n").unwrap();
    repo.git_ok(&["add", "wip.txt"]);

    squash_commits(
        repo.path(),
        Some("main"),
        &tip,
        &base,
        "replacement",
        "",
        None,
        None,
        None,
        false,
    )
    .expect("squash with pre-staged work");

    assert_eq!(
        rev_parse(&repo, "HEAD^{tree}"),
        tip_tree,
        "squash commit must be the squash-owned tip tree, not tip + pre-staged work"
    );
    assert!(
        !repo
            .git(&["cat-file", "-e", "HEAD:wip.txt"])
            .status
            .success(),
        "pre-staged path must not appear in the squash commit"
    );
    let cached_out = repo.git(&["diff", "--cached", "--name-only"]);
    let cached = String::from_utf8_lossy(&cached_out.stdout);
    assert!(
        cached.lines().any(|line| line == "wip.txt"),
        "pre-staged work must remain staged after squash; cached=\n{cached}"
    );
    let staged_blob = repo.git(&["show", ":wip.txt"]);
    assert_eq!(String::from_utf8_lossy(&staged_blob.stdout), "staged\n");
}

#[test]
fn squash_restores_pre_staged_work_when_commit_fails() {
    let (repo, base, tip) = tip_range_for_squash("squash-prestaged-rollback");
    std::fs::write(repo.0.join("wip.txt"), "keep-me\n").unwrap();
    repo.git_ok(&["add", "wip.txt"]);
    let before_cached = repo.git(&["diff", "--cached"]);

    repo.git_ok(&["config", "commit.gpgsign", "true"]);
    repo.git_ok(&["config", "gpg.format", "ssh"]);
    repo.git_ok(&[
        "config",
        "user.signingkey",
        "/definitely/missing/gitlane-test-signing-key",
    ]);

    let result = squash_commits(
        repo.path(),
        Some("main"),
        &tip,
        &base,
        "replacement",
        "",
        None,
        None,
        None,
        false,
    );
    assert!(
        result.is_err(),
        "missing signing key should reject the commit"
    );
    assert_eq!(rev_parse(&repo, "HEAD"), tip);
    assert_eq!(
        repo.git(&["diff", "--cached"]).stdout,
        before_cached.stdout,
        "failure must restore the exact pre-squash index snapshot"
    );
}

#[test]
fn squash_refuses_an_unmerged_index() {
    let (repo, base, tip) = tip_range_for_squash("squash-unmerged-refuse");
    repo.git_ok(&["checkout", "-q", "-b", "other", &base]);
    std::fs::write(repo.0.join("f.txt"), "other\n").unwrap();
    repo.git_ok(&["commit", "-q", "-a", "-m", "other"]);
    repo.git_ok(&["checkout", "-q", "main"]);
    let merge = repo.git(&["merge", "--no-commit", "other"]);
    assert!(
        !merge.status.success(),
        "setup must leave an unmerged index"
    );
    assert!(
        !String::from_utf8_lossy(&repo.git(&["ls-files", "-u"]).stdout)
            .trim()
            .is_empty(),
        "setup must produce unmerged stages"
    );

    let error = squash_commits(
        repo.path(),
        Some("main"),
        &tip,
        &base,
        "replacement",
        "",
        None,
        None,
        None,
        false,
    )
    .expect_err("unmerged index must refuse squash");
    assert!(
        error.contains("unresolved conflicts"),
        "unexpected refuse message: {error}"
    );
    assert_eq!(rev_parse(&repo, "HEAD"), tip, "refuse must not move HEAD");
}

#[test]
fn squash_skips_index_restore_when_live_index_diverges_after_commit() {
    let (repo, base, tip) = tip_range_for_squash("squash-compare-restore");
    let tip_tree = rev_parse(&repo, "HEAD^{tree}");
    std::fs::write(repo.0.join("wip.txt"), "staged\n").unwrap();
    repo.git_ok(&["add", "wip.txt"]);

    let repo_path = repo.0.clone();
    set_squash_after_commit_test_hook(move || {
        std::fs::write(repo_path.join("raced.txt"), "concurrent\n").unwrap();
        let status = Command::new("git")
            .arg("-C")
            .arg(&repo_path)
            .args(["add", "raced.txt"])
            .status()
            .expect("concurrent git add");
        assert!(status.success(), "concurrent staging must succeed");
    });

    let error = squash_commits(
        repo.path(),
        Some("main"),
        &tip,
        &base,
        "replacement",
        "",
        None,
        None,
        None,
        false,
    )
    .expect_err("diverged index must skip restore");
    assert!(
        error.contains("index changed during squash")
            && error.contains("pre-staged work was not reapplied"),
        "unexpected restore-skip message: {error}"
    );
    assert_eq!(
        rev_parse(&repo, "HEAD^{tree}"),
        tip_tree,
        "landed squash must not be undone when restore is skipped"
    );
    assert_ne!(rev_parse(&repo, "HEAD"), tip, "squash commit must remain");
    let cached_out = repo.git(&["diff", "--cached", "--name-only"]);
    let cached = String::from_utf8_lossy(&cached_out.stdout);
    assert!(
        cached.lines().any(|line| line == "raced.txt"),
        "concurrent staging must not be clobbered; cached=\n{cached}"
    );
    assert!(
        !cached.lines().any(|line| line == "wip.txt"),
        "skipped restore must leave pre-staged WIP unrestored"
    );
}

#[test]
fn squash_preserves_pre_staged_modification_deletion_partial_and_rename() {
    let (repo, base, _tip) = tip_range_for_squash("squash-prestaged-shapes");
    std::fs::write(repo.0.join("tracked.txt"), "tracked\n").unwrap();
    std::fs::write(repo.0.join("gone.txt"), "gone\n").unwrap();
    std::fs::write(repo.0.join("partial.txt"), "a\nb\n").unwrap();
    std::fs::write(repo.0.join("old-name.txt"), "rename-me\n").unwrap();
    repo.git_ok(&[
        "add",
        "tracked.txt",
        "gone.txt",
        "partial.txt",
        "old-name.txt",
    ]);
    repo.git_ok(&["commit", "-q", "-m", "shape fixtures"]);
    // Extend the tip range so squash still collapses onto `base`.
    std::fs::write(repo.0.join("f.txt"), "three\n").unwrap();
    repo.git_ok(&["commit", "-q", "-a", "-m", "three"]);
    let tip = rev_parse(&repo, "HEAD");
    let tip_tree = rev_parse(&repo, "HEAD^{tree}");

    // Modification
    std::fs::write(repo.0.join("tracked.txt"), "modified-staged\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    // Deletion
    repo.git_ok(&["rm", "gone.txt"]);
    // Partial: index has a\nb\nX, worktree has a\nb\nX\nY
    std::fs::write(repo.0.join("partial.txt"), "a\nb\nX\n").unwrap();
    repo.git_ok(&["add", "partial.txt"]);
    std::fs::write(repo.0.join("partial.txt"), "a\nb\nX\nY\n").unwrap();
    // Rename
    repo.git_ok(&["mv", "old-name.txt", "new-name.txt"]);

    let before_cached = repo.git(&["diff", "--cached"]);

    squash_commits(
        repo.path(),
        Some("main"),
        &tip,
        &base,
        "replacement",
        "",
        None,
        None,
        None,
        false,
    )
    .expect("squash with shaped pre-staged work");

    assert_eq!(rev_parse(&repo, "HEAD^{tree}"), tip_tree);
    assert_eq!(
        repo.git(&["diff", "--cached"]).stdout,
        before_cached.stdout,
        "exact index snapshot must restore every pre-staged shape"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("partial.txt")).unwrap(),
        "a\nb\nX\nY\n",
        "worktree must stay untouched"
    );
}

#[test]
fn squash_restores_pre_staged_work_when_a_guard_fails_after_read_tree() {
    // GL-307: the tip tree is installed into the index before the soft reset, so
    // a guard failure between the two must not return early — that would leave
    // the caller's staging replaced by the tip tree with no restore.
    let (repo, base, tip) = tip_range_for_squash("squash-guard-after-read-tree");
    std::fs::write(repo.0.join("wip.txt"), "keep-me\n").unwrap();
    repo.git_ok(&["add", "wip.txt"]);
    let before_staged = repo.git(&["ls-files", "-s"]).stdout;

    // Detaching HEAD leaves the post-reset `ensure_expected_head` unable to see
    // `main`, failing the guarded phase after `read-tree` already ran.
    let repo_path = repo.0.clone();
    set_squash_after_read_tree_test_hook(move || {
        let status = Command::new("git")
            .arg("-C")
            .arg(&repo_path)
            .args(["checkout", "-q", "--detach"])
            .status()
            .expect("detach HEAD");
        assert!(status.success(), "detaching HEAD must succeed");
    });

    let result = squash_commits(
        repo.path(),
        Some("main"),
        &tip,
        &base,
        "replacement",
        "",
        None,
        None,
        None,
        false,
    );

    assert!(
        result.is_err(),
        "a failed HEAD guard must reject the squash"
    );
    assert_eq!(
        rev_parse(&repo, "main"),
        tip,
        "the branch must not move when the guard fails"
    );
    assert_eq!(
        repo.git(&["ls-files", "-s"]).stdout,
        before_staged,
        "a guard failure after read-tree must restore the pre-squash index"
    );
}

#[test]
fn squash_rolls_back_the_soft_reset_when_commit_fails() {
    let (repo, base) = repo_with_base_commit("guarded-squash-rollback");
    std::fs::write(repo.0.join("f.txt"), "one\n").unwrap();
    repo.git_ok(&["commit", "-q", "-a", "-m", "one"]);
    std::fs::write(repo.0.join("f.txt"), "two\n").unwrap();
    repo.git_ok(&["commit", "-q", "-a", "-m", "two"]);
    let original_head = rev_parse(&repo, "HEAD");
    repo.git_ok(&["config", "commit.gpgsign", "true"]);
    repo.git_ok(&["config", "gpg.format", "ssh"]);
    repo.git_ok(&[
        "config",
        "user.signingkey",
        "/definitely/missing/gitlane-test-signing-key",
    ]);

    let result = squash_commits(
        repo.path(),
        Some("main"),
        &original_head,
        &base,
        "replacement",
        "",
        None,
        None,
        None,
        false,
    );
    assert!(
        result.is_err(),
        "missing signing key should reject the commit"
    );
    assert_eq!(rev_parse(&repo, "HEAD"), original_head);
}

#[test]
fn squash_does_not_qualify_the_parent_oid_into_a_same_named_branch() {
    // Squash soft-resets onto an oid it already resolved. Git permits a branch
    // and a tag literally named after that 40-hex string, so qualifying the
    // operand to refs/heads/<oid> would rewind onto a movable tip instead.
    let (repo, base) = repo_with_base_commit("guarded-squash-hex-named-ref");
    std::fs::write(repo.0.join("f.txt"), "one\n").unwrap();
    repo.git_ok(&["commit", "-q", "-a", "-m", "one"]);
    std::fs::write(repo.0.join("f.txt"), "two\n").unwrap();
    repo.git_ok(&["commit", "-q", "-a", "-m", "two"]);
    let original_head = rev_parse(&repo, "HEAD");
    repo.git_ok(&["branch", &base, &original_head]);
    repo.git_ok(&["tag", &base, &original_head]);

    squash_commits(
        repo.path(),
        Some("main"),
        &original_head,
        &base,
        "replacement",
        "",
        None,
        None,
        None,
        false,
    )
    .expect("squash onto the resolved parent oid");
    assert_eq!(
        rev_parse(&repo, "HEAD~1"),
        base,
        "squash must rewind to the resolved parent oid, not refs/heads/<oid>"
    );
}
