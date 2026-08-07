//! `commits` write-path tests.

use super::support::*;

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

#[cfg(unix)]
#[test]
fn squash_keeps_pre_staged_work_when_a_pre_commit_hook_stages() {
    // GL-307: `git commit` runs hooks, and a lint-staged-style pre-commit hook
    // stages into the same index. That staging belongs to the commit we just
    // made, so it must not read as a concurrent writer and skip the restore.
    use std::os::unix::fs::PermissionsExt;

    let (repo, base, tip) = tip_range_for_squash("squash-pre-commit-hook");
    let hook = repo.0.join(".git/hooks/pre-commit");
    std::fs::write(
        &hook,
        "#!/bin/sh\necho hooked > hooked.txt\ngit add hooked.txt\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

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
    .expect("a pre-commit hook that stages must not fail the squash");

    assert!(
        repo.git(&["cat-file", "-e", "HEAD:hooked.txt"])
            .status
            .success(),
        "the hook's staging belongs in the squash commit"
    );
    let cached_out = repo.git(&["diff", "--cached", "--name-only"]);
    let cached = String::from_utf8_lossy(&cached_out.stdout);
    assert!(
        cached.lines().any(|line| line == "wip.txt"),
        "pre-staged work must survive a hook-staging commit; cached=\n{cached}"
    );
    assert!(
        !repo
            .git(&["cat-file", "-e", "HEAD:wip.txt"])
            .status
            .success(),
        "pre-staged path must still stay out of the squash commit"
    );
    // The restored snapshot predates the hook, so without reconciliation the
    // index would read as deleting the very file the hook just committed.
    assert!(
        !cached.lines().any(|line| line == "hooked.txt"),
        "the hook's own path must not be left staged as a deletion; cached=\n{cached}"
    );
}

#[cfg(unix)]
#[test]
fn squash_refuses_to_restore_when_a_post_commit_hook_stages() {
    // A *post*-commit hook stages after the commit exists, so its writes are
    // indistinguishable from a concurrent `git add`. Compare-and-restore takes
    // the safe branch — refuse rather than clobber — and says so. Pinning the
    // policy here so a future change to it is deliberate, not accidental.
    use std::os::unix::fs::PermissionsExt;

    let (repo, base, tip) = tip_range_for_squash("squash-post-commit-hook");
    let hook = repo.0.join(".git/hooks/post-commit");
    std::fs::write(&hook, "#!/bin/sh\necho post > post.txt\ngit add post.txt\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

    std::fs::write(repo.0.join("wip.txt"), "keep-me\n").unwrap();
    repo.git_ok(&["add", "wip.txt"]);

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
    .expect_err("a post-commit hook mutating the index must refuse the restore");

    assert!(
        error.contains("index changed during squash"),
        "unexpected refusal message: {error}"
    );
    // The squash itself is kept — a landed commit is never undone — and the
    // caller's file is still on disk, just no longer staged.
    assert_ne!(
        rev_parse(&repo, "HEAD"),
        tip,
        "the squash commit must remain"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("wip.txt")).unwrap(),
        "keep-me\n",
        "refusing the restore must not touch the worktree"
    );
}

#[cfg(unix)]
#[test]
fn squash_reconciles_a_pre_commit_hook_rename_at_both_endpoints() {
    // `diff-tree --name-only` must list both sides of a rename; if it collapsed
    // to the post-image, the pre-rename path would be left staged for
    // resurrection against the new HEAD.
    use std::os::unix::fs::PermissionsExt;

    let (repo, base, _tip) = tip_range_for_squash("squash-hook-rename");
    std::fs::write(repo.0.join("before.txt"), "aaaa\nbbbb\ncccc\ndddd\n").unwrap();
    repo.git_ok(&["add", "before.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "add before"]);
    let tip = rev_parse(&repo, "HEAD");

    let hook = repo.0.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\ngit mv before.txt after.txt\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    // Rename detection on, to prove the plumbing call ignores it.
    repo.git_ok(&["config", "diff.renames", "true"]);

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
    .expect("squash with a renaming pre-commit hook");

    let cached_out = repo.git(&["diff", "--cached", "--name-only"]);
    let cached = String::from_utf8_lossy(&cached_out.stdout);
    assert!(
        !cached.lines().any(|line| line == "before.txt"),
        "the pre-rename path must not be left staged for resurrection; cached=\n{cached}"
    );
    assert!(
        !cached.lines().any(|line| line == "after.txt"),
        "the renamed path must match the landed commit; cached=\n{cached}"
    );
    assert!(
        cached.lines().any(|line| line == "wip.txt"),
        "pre-staged work must still survive; cached=\n{cached}"
    );
}

#[cfg(unix)]
#[test]
fn squash_prefers_pre_staged_content_over_a_pre_commit_hook_rewrite() {
    // Hook reconciliation must not overwrite the caller's own staging: when both
    // touch a path, the pre-staged version is the one worth keeping.
    use std::os::unix::fs::PermissionsExt;

    let (repo, base, _tip) = tip_range_for_squash("squash-hook-vs-pre-staged");
    std::fs::write(repo.0.join("shared.txt"), "committed\n").unwrap();
    repo.git_ok(&["add", "shared.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "add shared"]);
    let tip = rev_parse(&repo, "HEAD");

    let hook = repo.0.join(".git/hooks/pre-commit");
    std::fs::write(
        &hook,
        "#!/bin/sh\necho hook-rewrote > shared.txt\ngit add shared.txt\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

    std::fs::write(repo.0.join("shared.txt"), "mine-staged\n").unwrap();
    repo.git_ok(&["add", "shared.txt"]);

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
    .expect("squash with a hook rewriting a pre-staged path");

    let staged_blob = repo.git(&["show", ":shared.txt"]);
    assert_eq!(
        String::from_utf8_lossy(&staged_blob.stdout),
        "mine-staged\n",
        "the caller's staged content must outrank the hook's rewrite"
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

#[test]
fn pinned_identity_overrides_worktree_signing_for_gitlane_commits_and_tags() {
    let repo = TempRepo::new("identity-worktree-signing");
    repo.git_ok(&["init", "-q"]);
    set_repo_identity(
        repo.path(),
        "GitLane Author",
        "author@example.test",
        Some(""),
        Some(""),
        Some(false),
        Some(false),
    )
    .expect("set unsigned identity");

    // Worktree config has higher precedence than local config. Without the
    // command-scoped card policy these writes would try to sign with a missing
    // SSH key and both operations would fail.
    repo.git_ok(&["config", "extensions.worktreeConfig", "true"]);
    repo.git_ok(&["config", "--worktree", "gpg.format", "ssh"]);
    repo.git_ok(&[
        "config",
        "--worktree",
        "user.signingkey",
        "/missing/gitlane-signing-key.pub",
    ]);
    repo.git_ok(&["config", "--worktree", "commit.gpgsign", "true"]);
    repo.git_ok(&["config", "--worktree", "tag.gpgsign", "true"]);
    repo.git_ok(&["config", "--worktree", "user.name", "Worktree Override"]);
    repo.git_ok(&[
        "config",
        "--worktree",
        "user.email",
        "worktree-override@example.test",
    ]);

    std::fs::write(repo.0.join("file.txt"), "content\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    let captured_identity = repo_identity(repo.path())
        .expect("read selected identity")
        .expect("selected identity exists");
    super::super::commits::commit(
        repo.path(),
        "unsigned by selected card",
        "",
        false,
        Some("GitLane Author"),
        Some("author@example.test"),
        Some(&captured_identity),
        true,
    )
    .expect("card's commit.gpgsign=false overrides worktree config");
    create_annotated_tag(repo.path(), "v1", "release", None)
        .expect("card's tag.gpgsign=false overrides worktree config");
    let tagger = repo.git(&[
        "for-each-ref",
        "--format=%(taggername)|%(taggeremail)",
        "refs/tags/v1",
    ]);
    assert_eq!(
        String::from_utf8_lossy(&tagger.stdout).trim(),
        "GitLane Author|<author@example.test>",
        "annotated tagger must use the selected card, not worktree config"
    );

    let base_branch = String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout)
        .trim()
        .to_string();
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("feature.txt"), "feature\n").unwrap();
    repo.git_ok(&["add", "feature.txt"]);
    repo.git_ok(&[
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "feature",
    ]);
    repo.git_ok(&["checkout", "-q", &base_branch]);
    merge(repo.path(), "feature")
        .expect("implicit merge commit uses the selected card's signing policy");
}

#[test]
fn commit_rejects_a_captured_card_when_only_its_signing_policy_changes() {
    let repo = TempRepo::new("identity-stale-commit");
    repo.git_ok(&["init", "-q"]);
    set_repo_identity(
        repo.path(),
        "Shared Author",
        "shared@example.test",
        Some("FIRST-SIGNING-KEY"),
        Some("openpgp"),
        Some(false),
        Some(false),
    )
    .expect("set first identity");
    let first_identity = repo_identity(repo.path())
        .expect("read first identity")
        .expect("first identity exists");

    std::fs::write(repo.0.join("file.txt"), "content\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    set_repo_identity(
        repo.path(),
        "Shared Author",
        "shared@example.test",
        Some("SECOND-SIGNING-KEY"),
        Some("ssh"),
        Some(false),
        Some(false),
    )
    .expect("replace identity before stale commit arrives");

    let error = super::super::commits::commit(
        repo.path(),
        "must not use a mixed identity",
        "",
        false,
        Some("Shared Author"),
        Some("shared@example.test"),
        Some(&first_identity),
        true,
    )
    .expect_err("stale captured card must fail closed");
    assert!(error.contains("identity changed"), "{error}");
    assert!(
        !repo
            .git(&["rev-parse", "--verify", "HEAD"])
            .status
            .success(),
        "the rejected operation must not create a commit"
    );
}

#[test]
fn commit_rejects_a_card_applied_after_this_computer_was_captured() {
    let repo = TempRepo::new("identity-default-became-card");
    repo.git_ok(&["init", "-q"]);
    std::fs::write(repo.0.join("file.txt"), "content\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);

    // The composer captured no repo-local identity. A card lands before the
    // commit gets the identity lock; captured absence is still an expectation,
    // not permission to silently use whatever card is current now.
    set_repo_identity(
        repo.path(),
        "Late Card",
        "late@example.test",
        Some(""),
        Some(""),
        Some(false),
        Some(false),
    )
    .expect("apply card after composer snapshot");
    let error = super::super::commits::commit(
        repo.path(),
        "must not adopt the late card",
        "",
        false,
        None,
        None,
        None,
        true,
    )
    .expect_err("captured this-computer state must fail closed");
    assert!(error.contains("identity changed"), "{error}");
    assert!(
        !repo
            .git(&["rev-parse", "--verify", "HEAD"])
            .status
            .success(),
        "the rejected operation must not create a commit"
    );
}
