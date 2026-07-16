use super::branches::align_equivalent_sibling;
use super::conflict_resolution::{conflict_stage_absent, is_empty_after_resolution, worktree_path};
use super::lifecycle::init_in_place;
use super::operands::ensure_operand;
use super::remotes::{is_missing_remote_ref, is_tag_clobber_rejection};
use super::staging::{apply_hunk_patch, patch_diff_args, CLEAN_PATH_BATCH_MAX_ARGS};
use super::{
    abort_operation, accept_conflict_side, apply_hunk, apply_line, branch_push_remote,
    checkout_remote_branch, cherry_pick, cherry_pick_many, clear_repo_identity, continue_operation,
    create_tag, delete_branch_with_worktree, delete_remote_tag, discard_all, discard_file,
    fast_forward, fast_forward_branch, fetch, head_push_remote, mark_conflict_resolved, merge,
    move_branch_to_worktree, preview_delete_branch, preview_delete_remote_branch,
    preview_discard_all, preview_force_push, preview_reset, publish_branch, publish_remote, pull,
    reconflict_file, reflog_entries, remove_worktree, reset, resolve_conflict_file, revert,
    revert_many, set_remote_url, set_remote_username, set_repo_identity, set_upstream,
    skip_operation, stage_file, stage_files, stash, stash_apply, stash_branch, stash_drop,
    stash_list, stash_pop, unstage_all, unstage_file, unstage_files, worktrees, write_repo_file,
};
use crate::git::read::repo_identity;
use crate::git::transport_auth::TransportCredential;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

#[test]
fn rejects_dash_prefixed_operands() {
    // Option-injection vectors a malicious ref / raw input could carry into git.
    assert!(ensure_operand("--upload-pack=touch /tmp/x").is_err());
    assert!(ensure_operand("--exec=rm -rf /").is_err());
    assert!(ensure_operand("-D").is_err());
}

#[test]
fn allows_legitimate_refs_and_oids() {
    for ok in [
        "main",
        "feature/GP-3-foo",
        "origin/main",
        "2fe77a5abf25",
        "v1.2.3",
    ] {
        assert!(ensure_operand(ok).is_ok(), "{ok} should be allowed");
    }
}

/// A throwaway temp directory that cleans itself up on drop — keeps the test
/// dependency-free (no `tempfile` dev-dep) while never leaking dirs.
struct TempRepo(PathBuf);
impl TempRepo {
    fn new(tag: &str) -> Self {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("gitlane-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        TempRepo(dir)
    }
    fn path(&self) -> &str {
        self.0.to_str().unwrap()
    }
    fn git(&self, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .arg("-C")
            .arg(&self.0)
            .args(args)
            .output()
            .expect("git launches in tests")
    }
    fn git_ok(&self, args: &[&str]) {
        let out = self.git(args);
        assert!(
            out.status.success(),
            "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
            args,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        );
    }
}
impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn rev_parse(repo: &TempRepo, rev: &str) -> String {
    let out = repo.git(&["rev-parse", rev]);
    assert!(out.status.success(), "rev-parse {rev} should resolve");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// Build `base ─ main work ─ M` on `main` where `M` merges a `feature` branch
/// that added `feature.txt` (so `M`'s first parent is the mainline commit with
/// `main.txt`). Returns the repo and the merge commit's sha.
fn repo_with_merged_feature(tag: &str) -> (TempRepo, String) {
    let repo = TempRepo::new(tag);
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    // cherry_pick/revert honour repo config and would try to sign under a
    // developer's global commit.gpgsign=true — pin it off for hermetic tests.
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("feature.txt"), "feature\n").unwrap();
    repo.git_ok(&["add", "feature.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "feature work"]);
    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("main.txt"), "main\n").unwrap();
    repo.git_ok(&["add", "main.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "main work"]);
    repo.git_ok(&["merge", "-q", "--no-ff", "--no-edit", "feature"]);
    let sha = rev_parse(&repo, "HEAD");
    (repo, sha)
}

#[test]
fn checkout_remote_branch_creates_tracking_local_branch() {
    let repo = TempRepo::new("checkout-remote-branch");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", "HEAD"]);

    checkout_remote_branch(repo.path(), "origin", "feature").expect("checkout remote branch");

    let head = repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]);
    assert!(
        head.status.success(),
        "HEAD branch should resolve\nstderr:\n{}",
        String::from_utf8_lossy(&head.stderr),
    );
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "feature");
    let upstream = repo.git(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    assert!(
        upstream.status.success(),
        "upstream should resolve\nstderr:\n{}",
        String::from_utf8_lossy(&upstream.stderr),
    );
    assert_eq!(
        String::from_utf8_lossy(&upstream.stdout).trim(),
        "origin/feature"
    );
}

#[test]
fn checkout_remote_branch_fast_forwards_existing_local_branch() {
    let repo = TempRepo::new("checkout-existing-remote-branch");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["branch", "feature"]);
    std::fs::write(repo.0.join("ahead.txt"), "ahead\n").unwrap();
    repo.git_ok(&["add", "ahead.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "remote ahead"]);
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", "HEAD"]);

    checkout_remote_branch(repo.path(), "origin", "feature").expect("checkout remote branch");

    assert_eq!(rev_parse(&repo, "HEAD"), rev_parse(&repo, "origin/feature"));
    let head = repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]);
    assert!(head.status.success());
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "feature");
}

#[test]
fn checkout_remote_branch_succeeds_when_existing_local_tip_matches_remote() {
    let repo = TempRepo::new("checkout-equal-remote-branch");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["branch", "feature"]);
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", "HEAD"]);

    checkout_remote_branch(repo.path(), "origin", "feature").expect("checkout equal remote branch");

    assert_eq!(rev_parse(&repo, "HEAD"), rev_parse(&repo, "origin/feature"));
    let head = repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]);
    assert!(head.status.success());
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "feature");
}

#[test]
fn checkout_remote_branch_succeeds_when_existing_local_is_ahead() {
    let repo = TempRepo::new("checkout-local-ahead-remote-branch");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", "HEAD"]);
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("local.txt"), "local\n").unwrap();
    repo.git_ok(&["add", "local.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "local ahead"]);
    let local_tip = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "main"]);

    checkout_remote_branch(repo.path(), "origin", "feature").expect("checkout local-ahead branch");

    assert_eq!(rev_parse(&repo, "HEAD"), local_tip);
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), local_tip);
    let head = repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]);
    assert!(head.status.success());
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "feature");
}

#[test]
fn checkout_remote_branch_aligns_equivalent_sibling_commit() {
    let repo = TempRepo::new("checkout-equivalent-remote-branch");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    let base = rev_parse(&repo, "HEAD");

    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("tracked.txt"), "same result\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "local message"]);
    let local_tip = rev_parse(&repo, "HEAD");

    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("tracked.txt"), "same result\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "remote message (#123)"]);
    let remote_tip = rev_parse(&repo, "HEAD");
    assert_ne!(local_tip, remote_tip);
    assert_eq!(
        rev_parse(&repo, "feature^{tree}"),
        rev_parse(&repo, "HEAD^{tree}")
    );
    assert_eq!(rev_parse(&repo, "feature^"), base);
    assert_eq!(rev_parse(&repo, "HEAD^"), base);
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", "HEAD"]);

    checkout_remote_branch(repo.path(), "origin", "feature")
        .expect("equivalent sibling should align to remote commit");

    assert_eq!(rev_parse(&repo, "HEAD"), remote_tip);
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), remote_tip);
    let status = repo.git(&["status", "--short"]);
    assert!(status.status.success());
    assert!(status.stdout.is_empty(), "worktree should stay clean");
}

#[test]
fn checkout_remote_branch_preserves_dirty_state_while_aligning_equivalent_sibling() {
    let repo = TempRepo::new("checkout-dirty-equivalent-remote-branch");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);

    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("tracked.txt"), "committed\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "local message"]);
    let local_tip = rev_parse(&repo, "HEAD");
    let tree = rev_parse(&repo, "HEAD^{tree}");
    let parent = rev_parse(&repo, "HEAD^");
    let remote_tip_out = repo.git(&[
        "commit-tree",
        &tree,
        "-p",
        &parent,
        "-m",
        "remote message (#123)",
    ]);
    assert!(remote_tip_out.status.success());
    let remote_tip = String::from_utf8_lossy(&remote_tip_out.stdout)
        .trim()
        .to_string();
    assert_ne!(local_tip, remote_tip);
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", &remote_tip]);
    std::fs::write(repo.0.join("tracked.txt"), "staged\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    std::fs::write(repo.0.join("tracked.txt"), "dirty\n").unwrap();
    std::fs::write(repo.0.join("untracked.txt"), "untracked\n").unwrap();

    checkout_remote_branch(repo.path(), "origin", "feature")
        .expect("equivalent sibling should align without resetting files");

    assert_eq!(rev_parse(&repo, "HEAD"), remote_tip);
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "dirty\n"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("untracked.txt")).unwrap(),
        "untracked\n"
    );
    let indexed = repo.git(&["show", ":tracked.txt"]);
    assert!(indexed.status.success());
    assert_eq!(String::from_utf8_lossy(&indexed.stdout), "staged\n");
    let status = String::from_utf8_lossy(&repo.git(&["status", "--short"]).stdout).to_string();
    assert!(
        status.contains("MM tracked.txt"),
        "unexpected status: {status}"
    );
    assert!(
        status.contains("?? untracked.txt"),
        "unexpected status: {status}"
    );
}

#[test]
fn checkout_remote_branch_refuses_same_tree_with_different_parents() {
    let repo = TempRepo::new("checkout-same-tree-different-parents");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    let base = rev_parse(&repo, "HEAD");
    let base_tree = rev_parse(&repo, "HEAD^{tree}");
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("tracked.txt"), "same result\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "local"]);
    let local_tip = rev_parse(&repo, "HEAD");
    let feature_tree = rev_parse(&repo, "HEAD^{tree}");

    let alternate_parent = repo.git(&[
        "commit-tree",
        &base_tree,
        "-p",
        &base,
        "-m",
        "alternate parent",
    ]);
    assert!(alternate_parent.status.success());
    let alternate_parent = String::from_utf8_lossy(&alternate_parent.stdout)
        .trim()
        .to_string();
    let remote_tip = repo.git(&[
        "commit-tree",
        &feature_tree,
        "-p",
        &alternate_parent,
        "-m",
        "remote",
    ]);
    assert!(remote_tip.status.success());
    let remote_tip = String::from_utf8_lossy(&remote_tip.stdout)
        .trim()
        .to_string();
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", &remote_tip]);

    let error = checkout_remote_branch(repo.path(), "origin", "feature")
        .expect_err("same tree with different parents must remain divergent");

    assert!(error.contains("have diverged"), "unexpected: {error}");
    assert_eq!(rev_parse(&repo, "HEAD"), local_tip);
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), local_tip);
}

#[test]
fn checkout_remote_branch_refuses_during_an_active_merge() {
    let repo = TempRepo::new("checkout-equivalent-during-merge");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    let base = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("feature.txt"), "feature\n").unwrap();
    repo.git_ok(&["add", "feature.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "local"]);
    let local_tip = rev_parse(&repo, "HEAD");
    let tree = rev_parse(&repo, "HEAD^{tree}");
    let remote_tip = repo.git(&["commit-tree", &tree, "-p", &base, "-m", "remote"]);
    assert!(remote_tip.status.success());
    let remote_tip = String::from_utf8_lossy(&remote_tip.stdout)
        .trim()
        .to_string();
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", &remote_tip]);

    repo.git_ok(&["checkout", "-q", "-b", "merge-source", &base]);
    std::fs::write(repo.0.join("merge.txt"), "merge\n").unwrap();
    repo.git_ok(&["add", "merge.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "merge source"]);
    repo.git_ok(&["checkout", "-q", "feature"]);
    repo.git_ok(&["merge", "-q", "--no-commit", "--no-ff", "merge-source"]);
    let merge_head = rev_parse(&repo, "MERGE_HEAD");

    let error = checkout_remote_branch(repo.path(), "origin", "feature")
        .expect_err("active merge must block remote checkout");

    assert!(error.contains("merge operation"), "unexpected: {error}");
    assert_eq!(rev_parse(&repo, "HEAD"), local_tip);
    assert_eq!(rev_parse(&repo, "MERGE_HEAD"), merge_head);
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), local_tip);
}

#[test]
fn checkout_remote_branch_refuses_during_a_paused_rebase() {
    let repo = TempRepo::new("checkout-equivalent-during-rebase");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    let base = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("feature.txt"), "feature\n").unwrap();
    repo.git_ok(&["add", "feature.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "local"]);
    let local_tip = rev_parse(&repo, "HEAD");
    let tree = rev_parse(&repo, "HEAD^{tree}");
    let remote_tip = repo.git(&["commit-tree", &tree, "-p", &base, "-m", "remote"]);
    assert!(remote_tip.status.success());
    let remote_tip = String::from_utf8_lossy(&remote_tip.stdout)
        .trim()
        .to_string();
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", &remote_tip]);

    repo.git_ok(&["checkout", "-q", "-b", "onto", &base]);
    std::fs::write(repo.0.join("onto.txt"), "onto\n").unwrap();
    repo.git_ok(&["add", "onto.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "onto"]);
    repo.git_ok(&["checkout", "-q", "feature"]);
    let paused = repo.git(&["rebase", "--exec", "false", "onto"]);
    assert!(
        !paused.status.success(),
        "rebase should pause at the exec step"
    );
    let status = crate::git::conflicts::operation_status(repo.path()).expect("operation status");
    assert_eq!(status.kind, "rebase");

    let error = checkout_remote_branch(repo.path(), "origin", "feature")
        .expect_err("paused rebase must block remote checkout");

    assert!(error.contains("rebase operation"), "unexpected: {error}");
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), local_tip);
    let after = crate::git::conflicts::operation_status(repo.path()).expect("operation status");
    assert_eq!(after.kind, "rebase");
}

#[test]
fn equivalent_alignment_refuses_a_stale_remote_oid_atomically() {
    let repo = TempRepo::new("checkout-equivalent-remote-race");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    let base = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("tracked.txt"), "same result\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "local"]);
    let local_tip = rev_parse(&repo, "HEAD");
    let tree = rev_parse(&repo, "HEAD^{tree}");
    let classified_remote = repo.git(&["commit-tree", &tree, "-p", &base, "-m", "remote"]);
    assert!(classified_remote.status.success());
    let classified_remote = String::from_utf8_lossy(&classified_remote.stdout)
        .trim()
        .to_string();
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", &base]);

    let error = align_equivalent_sibling(
        repo.path(),
        "refs/heads/feature",
        "refs/remotes/origin/feature",
        &local_tip,
        &classified_remote,
    )
    .expect_err("a moved remote ref must abort the whole transaction");

    assert!(error.contains("cannot lock ref"), "unexpected: {error}");
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), local_tip);
    assert_eq!(rev_parse(&repo, "refs/remotes/origin/feature"), base);
}

#[test]
fn checkout_remote_branch_refuses_diverged_existing_local_branch() {
    let repo = TempRepo::new("checkout-diverged-remote-branch");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("local.txt"), "local\n").unwrap();
    repo.git_ok(&["add", "local.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "local work"]);
    let local_tip = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("remote.txt"), "remote\n").unwrap();
    repo.git_ok(&["add", "remote.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "remote work"]);
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", "HEAD"]);
    let previous_head = rev_parse(&repo, "HEAD");

    let error = checkout_remote_branch(repo.path(), "origin", "feature")
        .expect_err("diverged branch must refuse fast-forward checkout");

    assert!(error.contains("have diverged"), "unexpected: {error}");
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), local_tip);
    assert_eq!(rev_parse(&repo, "HEAD"), previous_head);
    let head = repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]);
    assert!(head.status.success());
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "main");
}

#[test]
fn checkout_remote_branch_reports_switch_when_dirty_changes_block_fast_forward() {
    let repo = TempRepo::new("checkout-dirty-remote-branch");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    let base = rev_parse(&repo, "HEAD");
    repo.git_ok(&["branch", "feature"]);
    std::fs::write(repo.0.join("tracked.txt"), "remote\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "remote work"]);
    repo.git_ok(&["remote", "add", "origin", "https://example.test/repo.git"]);
    repo.git_ok(&["update-ref", "refs/remotes/origin/feature", "HEAD"]);
    repo.git_ok(&["checkout", "-q", "-b", "other", &base]);
    std::fs::write(repo.0.join("tracked.txt"), "dirty\n").unwrap();

    let error = checkout_remote_branch(repo.path(), "origin", "feature")
        .expect_err("dirty change must block the fast-forward merge");

    assert!(error.contains("feature is checked out"), "unexpected: {error}");
    assert!(error.contains("couldn't be fast-forwarded"), "unexpected: {error}");
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), base);
    let head = repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]);
    assert!(head.status.success());
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "feature");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "dirty\n"
    );
}

#[test]
fn revert_of_a_merge_commit_defaults_to_mainline_one() {
    // Without `-m 1` git refuses outright: "commit … is a merge but no -m
    // option was given" — the swimlane UI's Revert must work on merges.
    let (repo, merge_sha) = repo_with_merged_feature("revert-merge");

    revert(repo.path(), &merge_sha).expect("revert a merge commit");

    assert!(
        !repo.0.join("feature.txt").exists(),
        "the merged-in change is undone"
    );
    assert!(
        repo.0.join("main.txt").exists(),
        "first-parent (mainline) history survives the revert"
    );
    assert!(repo.0.join("base.txt").exists());
}

#[test]
fn cherry_pick_of_a_merge_applies_the_first_parent_delta() {
    let (repo, merge_sha) = repo_with_merged_feature("cherry-pick-merge");
    // A branch rooted before the merge — picking the merge onto it must apply
    // exactly what the merge introduced relative to its first parent.
    repo.git_ok(&["checkout", "-q", "-b", "dest", &format!("{merge_sha}~2")]);

    cherry_pick(repo.path(), &merge_sha).expect("cherry-pick a merge commit");

    assert!(
        repo.0.join("feature.txt").exists(),
        "the first-parent delta (the merged branch's change) is applied"
    );
    assert!(
        !repo.0.join("main.txt").exists(),
        "the mainline commit itself is not dragged along"
    );
}

#[test]
fn revert_many_splits_a_mixed_normal_and_merge_selection() {
    // `git revert -m 1 A B` rejects a non-merge B, so a mixed selection has to
    // run as consecutive same-kind invocations — both commits must be undone.
    let (repo, merge_sha) = repo_with_merged_feature("revert-many-mixed");
    std::fs::write(repo.0.join("extra.txt"), "extra\n").unwrap();
    repo.git_ok(&["add", "extra.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "extra"]);
    let extra_sha = rev_parse(&repo, "HEAD");

    revert_many(repo.path(), &[extra_sha, merge_sha]).expect("revert normal + merge");

    assert!(!repo.0.join("extra.txt").exists(), "normal commit reverted");
    assert!(
        !repo.0.join("feature.txt").exists(),
        "merge commit reverted"
    );
    assert!(
        repo.0.join("main.txt").exists(),
        "mainline history survives"
    );
}

#[test]
fn cherry_pick_many_splits_a_mixed_normal_and_merge_selection() {
    let (repo, merge_sha) = repo_with_merged_feature("cherry-pick-many-mixed");
    let mainline_sha = rev_parse(&repo, &format!("{merge_sha}~1"));
    repo.git_ok(&["checkout", "-q", "-b", "dest", &format!("{merge_sha}~2")]);

    cherry_pick_many(repo.path(), &[mainline_sha, merge_sha]).expect("cherry-pick normal + merge");

    assert!(repo.0.join("main.txt").exists(), "normal commit applied");
    assert!(
        repo.0.join("feature.txt").exists(),
        "merge's first-parent delta applied"
    );
}

#[test]
fn set_repo_identity_round_trips_signing_and_respects_tri_state() {
    let repo = TempRepo::new("identity-signing");
    repo.git_ok(&["init", "-q"]);

    // Apply a profile that signs: name/email + signing key, format, gpgsign, tags.
    set_repo_identity(
        repo.path(),
        "Work Dev",
        "work@example.test",
        Some("ABCD1234"),
        Some("openpgp"),
        Some(true),
        Some(true),
    )
    .expect("set identity with signing");

    let id = repo_identity(repo.path())
        .expect("read identity")
        .expect("identity present");
    assert_eq!(id.name, "Work Dev");
    assert_eq!(id.email, "work@example.test");
    assert_eq!(id.signing_key.as_deref(), Some("ABCD1234"));
    assert_eq!(id.gpg_format.as_deref(), Some("openpgp"));
    assert_eq!(id.gpg_sign, Some(true));
    assert_eq!(id.tag_gpg_sign, Some(true));

    // `None` leaves signing untouched — the legacy name/email editor must not
    // wipe a key the user (or a prior profile) set.
    set_repo_identity(
        repo.path(),
        "Work Dev",
        "work@example.test",
        None,
        None,
        None,
        None,
    )
    .expect("re-save name/email only");
    let id = repo_identity(repo.path()).unwrap().unwrap();
    assert_eq!(
        id.signing_key.as_deref(),
        Some("ABCD1234"),
        "None must not disturb existing signing"
    );
    assert_eq!(id.gpg_sign, Some(true));

    // Switching to a no-signing profile: empty string unsets the key/format,
    // gpgsign=false is written (so signing is explicitly off, not inherited).
    set_repo_identity(
        repo.path(),
        "Solo",
        "solo@example.test",
        Some(""),
        Some(""),
        Some(false),
        Some(false),
    )
    .expect("apply no-signing profile");
    let id = repo_identity(repo.path()).unwrap().unwrap();
    assert_eq!(id.signing_key, None, "empty signing key unsets it");
    assert_eq!(id.gpg_format, None, "empty gpg.format unsets it");
    assert_eq!(
        id.gpg_sign,
        Some(false),
        "gpgSign=false is written, not unset"
    );
    assert_eq!(id.tag_gpg_sign, Some(false), "tag.gpgsign=false is written");
}

#[test]
fn clear_repo_identity_removes_name_email_and_signing() {
    let repo = TempRepo::new("identity-clear");
    repo.git_ok(&["init", "-q"]);
    set_repo_identity(
        repo.path(),
        "Work",
        "work@example.test",
        Some("KEY1"),
        Some("ssh"),
        Some(true),
        Some(true),
    )
    .expect("set identity with signing");

    clear_repo_identity(repo.path()).expect("clear identity");

    // With name/email gone the read returns None; the signing keys are also
    // unset so a stale key can't outlive the identity it belonged to.
    assert!(
        repo_identity(repo.path()).unwrap().is_none(),
        "identity fully cleared"
    );
    let signing = repo.git(&["config", "--local", "--get", "user.signingkey"]);
    assert!(
        !signing.status.success(),
        "user.signingkey should be unset after clear"
    );
}

#[test]
fn create_tag_stays_lightweight_under_tag_gpgsign() {
    let repo = TempRepo::new("lightweight-tag-gpgsign");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    // The regression: tag.gpgsign=true upgrades a plain `git tag` to a *signed*
    // tag, which needs a message — git then launches an editor this GUI
    // subprocess can't provide and the command fails. `--no-sign` must keep the
    // "Tag here…" path genuinely lightweight.
    repo.git_ok(&["config", "tag.gpgsign", "true"]);
    std::fs::write(repo.0.join("a.txt"), "one\n").unwrap();
    repo.git_ok(&["add", "a.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "initial"]);

    create_tag(repo.path(), "v0.0.1", None).expect("lightweight tag under tag.gpgsign=true");

    // A lightweight tag points straight at the commit; a signed/annotated one
    // would resolve to a tag object.
    let out = repo.git(&["cat-file", "-t", "refs/tags/v0.0.1"]);
    assert!(out.status.success(), "tag ref should exist");
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "commit",
        "tag must stay lightweight (no tag object)"
    );
}

#[test]
fn delete_remote_tag_removes_only_the_tag_on_the_remote() {
    let repo = TempRepo::new("delete-remote-tag");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "one\n").unwrap();
    repo.git_ok(&["add", "a.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "initial"]);
    repo.git_ok(&["tag", "--no-sign", "v1"]);
    // A branch sharing the tag's short name — the fully-qualified `refs/tags/`
    // delete refspec must never touch it.
    repo.git_ok(&["branch", "v1"]);

    let remote = TempRepo::new("delete-remote-tag-origin");
    remote.git_ok(&["init", "-q", "--bare"]);
    repo.git_ok(&["remote", "add", "origin", remote.path()]);
    repo.git_ok(&["push", "-q", "origin", "refs/tags/v1", "refs/heads/v1"]);

    delete_remote_tag(repo.path(), "origin", "v1", &TransportCredential::None)
        .expect("delete tag on remote");

    let tags = remote.git(&["tag"]);
    assert!(
        !String::from_utf8_lossy(&tags.stdout).contains("v1"),
        "remote tag should be gone"
    );
    let branch = remote.git(&["show-ref", "--verify", "refs/heads/v1"]);
    assert!(
        branch.status.success(),
        "same-named remote branch must survive the tag delete"
    );
    let local = repo.git(&["show-ref", "--verify", "refs/tags/v1"]);
    assert!(
        local.status.success(),
        "local tag ref is not touched by the remote delete"
    );
}

#[test]
fn delete_remote_tag_tolerates_a_tag_that_was_never_pushed() {
    let repo = TempRepo::new("delete-remote-tag-unpushed");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "one\n").unwrap();
    repo.git_ok(&["add", "a.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "initial"]);
    repo.git_ok(&["tag", "--no-sign", "v9"]);

    let remote = TempRepo::new("delete-remote-tag-unpushed-origin");
    remote.git_ok(&["init", "-q", "--bare"]);
    repo.git_ok(&["remote", "add", "origin", remote.path()]);

    // "Delete everywhere" on a local-only tag: absence upstream is the desired
    // end state, so this must not fail (the combined delete then proceeds to
    // the local half). How git reports it varies by transport — file remotes
    // exit 0 with a "deleting a non-existent ref" warning, smart-HTTP servers
    // reject with "remote ref does not exist" (mapped to Ok by the tolerance
    // tested below) — so assert the behavior, not the message.
    delete_remote_tag(repo.path(), "origin", "v9", &TransportCredential::None)
        .expect("missing remote ref is not a failure");

    let local = repo.git(&["show-ref", "--verify", "refs/tags/v9"]);
    assert!(local.status.success(), "local tag is untouched");
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
fn discard_all_clears_staged_files_in_unborn_repo() {
    let repo = TempRepo::new("discard");
    repo.git(&["init", "-q"]);
    // Stage a file *before any commit* — the regression case: with no HEAD,
    // `reset --hard` is skipped, and the file is tracked in the index so a
    // plain `git clean` would leave it behind.
    std::fs::write(repo.0.join("staged.txt"), b"hello").unwrap();
    repo.git(&["add", "staged.txt"]);

    let result = discard_all(repo.path());
    assert!(result.is_ok(), "discard_all failed: {result:?}");

    // Both the worktree copy and the index entry must be gone.
    assert!(
        !repo.0.join("staged.txt").exists(),
        "worktree file survived discard"
    );
    let status = repo.git(&["status", "--porcelain"]);
    let out = String::from_utf8_lossy(&status.stdout);
    assert!(
        out.trim().is_empty(),
        "repo not clean after discard: {out:?}"
    );
}

#[cfg(unix)]
#[test]
fn discard_all_reports_an_emptied_unborn_index_when_cleanup_fails() {
    use std::os::unix::fs::PermissionsExt;

    let repo = TempRepo::new("discard-unborn-clean-failure");
    repo.git_ok(&["init", "-q"]);
    std::fs::create_dir(repo.0.join("blocked")).unwrap();
    std::fs::write(repo.0.join("blocked/staged.txt"), "new\n").unwrap();
    repo.git_ok(&["add", "blocked/staged.txt"]);
    std::fs::set_permissions(
        repo.0.join("blocked"),
        std::fs::Permissions::from_mode(0o555),
    )
    .unwrap();

    let result = discard_all(repo.path());

    std::fs::set_permissions(
        repo.0.join("blocked"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let error = result.expect_err("unwritable parent should block cleanup");
    assert!(
        error.contains("The index was cleared, but untracked cleanup could not finish"),
        "unexpected partial-failure diagnostic: {error}"
    );
    assert!(
        repo.0.join("blocked/staged.txt").exists(),
        "failed cleanup should leave the worktree file in place"
    );
    let cached = repo.git(&["ls-files", "--cached"]);
    assert!(
        String::from_utf8_lossy(&cached.stdout).trim().is_empty(),
        "the diagnostic promises that the unborn index was cleared"
    );
}

#[test]
fn discard_all_preserves_empty_untracked_directories() {
    let repo = TempRepo::new("discard-empty-dir");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "initial"]);

    std::fs::write(repo.0.join("tracked.txt"), "changed\n").unwrap();
    std::fs::create_dir(repo.0.join("untracked-dir")).unwrap();
    std::fs::write(repo.0.join("untracked-dir/file.txt"), "new\n").unwrap();
    std::fs::create_dir(repo.0.join("empty-dir")).unwrap();

    discard_all(repo.path()).expect("discard_all");

    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "base\n"
    );
    assert!(!repo.0.join("untracked-dir/file.txt").exists());
    assert!(
        repo.0.join("untracked-dir").is_dir(),
        "only the reported untracked file is removed; the directory shell remains"
    );
    assert!(
        repo.0.join("empty-dir").is_dir(),
        "empty directories are not Git changes and must be preserved"
    );
    let status = repo.git(&["status", "--porcelain", "--untracked-files=all"]);
    assert!(
        String::from_utf8_lossy(&status.stdout).trim().is_empty(),
        "repo should be clean after discard"
    );
}

#[test]
fn discard_all_preserves_nested_empty_directories_inside_cleaned_trees() {
    let repo = TempRepo::new("discard-nested-empty");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "initial"]);

    std::fs::write(repo.0.join("tracked.txt"), "changed\n").unwrap();
    std::fs::create_dir_all(repo.0.join("untracked-dir/empty-nested")).unwrap();
    std::fs::write(repo.0.join("untracked-dir/file.txt"), "new\n").unwrap();

    discard_all(repo.path()).expect("discard_all");

    assert!(!repo.0.join("untracked-dir/file.txt").exists());
    assert!(
        repo.0.join("untracked-dir/empty-nested").is_dir(),
        "nested empty directories must survive cleanup of sibling untracked files"
    );
}

#[test]
fn discard_all_preserves_nested_git_repositories_and_resets_other_changes() {
    let repo = repo_with_file("discard-nested-repo", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("tracked.txt"), "changed\n").unwrap();
    std::fs::write(repo.0.join("untracked.txt"), "remove me\n").unwrap();
    std::fs::create_dir(repo.0.join("nested")).unwrap();
    repo.git_ok(&["-C", "nested", "init", "-q"]);
    std::fs::write(repo.0.join("nested/file.txt"), "nested\n").unwrap();

    let result = discard_all(repo.path()).expect("nested repositories are a protected exception");

    assert!(
        result.contains("preserved nested Git repositories") && result.contains("nested/"),
        "success must report the protected path: {result}"
    );
    assert!(
        repo.0.join("nested/.git").is_dir(),
        "a single -f must preserve an untracked nested repository"
    );
    assert!(
        !repo.0.join("untracked.txt").exists(),
        "ordinary untracked files should still be removed"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "base\n",
        "tracked edits should still be reset"
    );
}

#[test]
fn discard_all_reports_when_reset_fails_after_untracked_cleanup() {
    let repo = repo_with_file("discard-reset-failure", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("tracked.txt"), "changed\n").unwrap();
    std::fs::write(repo.0.join("untracked.txt"), "new\n").unwrap();
    std::fs::write(repo.0.join(".git/index.lock"), "locked\n").unwrap();

    let result = discard_all(repo.path());

    std::fs::remove_file(repo.0.join(".git/index.lock")).unwrap();
    let error = result.expect_err("the index lock should block reset");
    assert!(
        error.contains("Untracked cleanup completed, but tracked changes could not be reset"),
        "unexpected partial-failure diagnostic: {error}"
    );
    assert!(
        !repo.0.join("untracked.txt").exists(),
        "untracked cleanup should finish before reset starts"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "changed\n",
        "failed reset should leave tracked edits intact"
    );
}

#[test]
fn discard_all_cleans_untracked_paths_across_argument_batches() {
    let repo = repo_with_file("discard-batches", "tracked.txt", b"base\n");
    for index in 0..=CLEAN_PATH_BATCH_MAX_ARGS {
        std::fs::write(repo.0.join(format!("untracked-{index}.txt")), "new\n").unwrap();
    }

    discard_all(repo.path()).expect("discard_all");

    let status = repo.git(&["status", "--porcelain", "--untracked-files=all"]);
    assert!(
        String::from_utf8_lossy(&status.stdout).trim().is_empty(),
        "every untracked path should be cleaned across batches"
    );
}

#[test]
fn discard_all_preserves_leading_whitespace_in_untracked_paths() {
    let repo = repo_with_file("discard-leading-space", "tracked.txt", b"base\n");
    let path = repo.0.join(" leading-space.txt");
    std::fs::write(&path, "new\n").unwrap();

    discard_all(repo.path()).expect("discard_all");

    assert!(!path.exists(), "the exact leading-space path should be cleaned");
}

#[cfg(not(windows))]
#[test]
fn discard_all_treats_pathspec_magic_as_a_literal_filename() {
    let repo = repo_with_file("discard-pathspec-magic", "tracked.txt", b"base\n");
    let path = repo.0.join(":(");
    std::fs::write(&path, "new\n").unwrap();

    discard_all(repo.path()).expect("discard_all");

    assert!(!path.exists(), "the pathspec-like filename should be cleaned");
}

#[cfg(target_os = "linux")]
#[test]
fn discard_all_removes_non_utf8_untracked_paths() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let repo = repo_with_file("discard-non-utf8", "tracked.txt", b"base\n");
    let path = OsStr::from_bytes(b"untracked\xff.txt");
    std::fs::write(repo.0.join(path), b"new\n").unwrap();

    discard_all(repo.path()).expect("discard_all");

    assert!(
        !repo.0.join(path).exists(),
        "non-UTF-8 untracked paths must be removed, not lossy-skipped"
    );
}

#[test]
fn move_branch_to_worktree_detaches_source_then_checks_out_branch() {
    let repo = TempRepo::new("move-worktree-branch");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["branch", "-M", "main"]);
    std::fs::write(repo.0.join("file.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    repo.git_ok(&["branch", "feature"]);

    let linked = std::env::temp_dir().join(format!(
        "gitlane-move-worktree-branch-linked-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&linked);
    let linked_str = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", linked_str, "feature"]);

    let result = move_branch_to_worktree(
        repo.path(),
        "feature",
        linked_str,
        repo.path(),
        false,
        &|_| {},
    )
    .expect("move branch from linked worktree");
    assert!(
        result.starts_with("Moved feature to "),
        "unexpected message: {result}"
    );

    let current = repo.git(&["branch", "--show-current"]);
    assert_eq!(String::from_utf8_lossy(&current.stdout).trim(), "feature");

    let source_head = Command::new("git")
        .arg("-C")
        .arg(&linked)
        .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
        .output()
        .expect("git launches in linked worktree");
    assert!(
        !source_head.status.success(),
        "source worktree should be detached, got {}",
        String::from_utf8_lossy(&source_head.stdout)
    );

    let _ = repo.git(&["worktree", "remove", "--force", linked_str]);
    let _ = std::fs::remove_dir_all(&linked);
}

#[test]
fn delete_branch_with_worktree_removes_worktree_then_deletes_branch() {
    let repo = TempRepo::new("delete-worktree-branch");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["branch", "-M", "main"]);
    std::fs::write(repo.0.join("file.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    repo.git_ok(&["branch", "feature"]);

    let linked = std::env::temp_dir().join(format!(
        "gitlane-delete-worktree-branch-linked-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&linked);
    let linked_str = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", linked_str, "feature"]);

    // The dialog's checklist depends on these ids firing in this order, one per
    // phase as it begins (GL-107).
    let steps = std::cell::RefCell::new(Vec::new());
    let result = delete_branch_with_worktree(repo.path(), "feature", linked_str, &|s| {
        steps.borrow_mut().push(s)
    })
    .expect("delete branch and its worktree");
    assert_eq!(result, "Deleted feature and its worktree");
    assert_eq!(*steps.borrow(), ["removeWorktree", "deleteBranch"]);

    // The branch is gone...
    let branches = repo.git(&["branch", "--list", "feature"]);
    assert!(
        String::from_utf8_lossy(&branches.stdout).trim().is_empty(),
        "feature branch should be deleted"
    );
    // ...and so is the worktree registration (and its directory).
    let worktrees = repo.git(&["worktree", "list", "--porcelain"]);
    let listing = String::from_utf8_lossy(&worktrees.stdout);
    assert!(
        !listing.contains(linked_str),
        "linked worktree should be removed, still in: {listing}"
    );
    assert!(!linked.exists(), "linked worktree directory should be gone");

    let _ = std::fs::remove_dir_all(&linked);
}

#[test]
fn delete_branch_with_worktree_refuses_a_dirty_worktree() {
    let repo = TempRepo::new("delete-worktree-branch-dirty");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["branch", "-M", "main"]);
    std::fs::write(repo.0.join("file.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    repo.git_ok(&["branch", "feature"]);

    let linked = std::env::temp_dir().join(format!(
        "gitlane-delete-worktree-branch-dirty-linked-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&linked);
    let linked_str = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", linked_str, "feature"]);
    // Make the worktree dirty so the (unforced) removal must refuse.
    std::fs::write(linked.join("file.txt"), "edited\n").unwrap();

    let err = delete_branch_with_worktree(repo.path(), "feature", linked_str, &|_| {})
        .expect_err("dirty worktree should abort the delete");
    assert!(!err.is_empty(), "expected a git error message");

    // Nothing was destroyed: the branch and worktree both survive.
    let branches = repo.git(&["branch", "--list", "feature"]);
    assert!(
        String::from_utf8_lossy(&branches.stdout).contains("feature"),
        "feature branch must survive a refused delete"
    );
    assert!(linked.exists(), "dirty worktree directory must survive");

    let _ = repo.git(&["worktree", "remove", "--force", linked_str]);
    let _ = std::fs::remove_dir_all(&linked);
}

#[test]
fn delete_branch_with_worktree_refuses_when_path_no_longer_holds_the_branch() {
    // The frontend's captured path can go stale: an external checkout/detach in
    // the source worktree means it no longer owns the branch. The op must verify
    // against live `git worktree list` and abort — never remove a clean,
    // now-unrelated worktree and then delete the branch anyway.
    let repo = TempRepo::new("delete-worktree-branch-stale");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["branch", "-M", "main"]);
    std::fs::write(repo.0.join("file.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    repo.git_ok(&["branch", "feature"]);

    let linked = std::env::temp_dir().join(format!(
        "gitlane-delete-worktree-branch-stale-linked-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&linked);
    let linked_str = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", linked_str, "feature"]);
    // Simulate the external change: the source worktree detaches off `feature`.
    let detach = Command::new("git")
        .arg("-C")
        .arg(&linked)
        .args(["checkout", "--detach", "-q"])
        .output()
        .expect("git detaches the linked worktree");
    assert!(detach.status.success());

    let err = delete_branch_with_worktree(repo.path(), "feature", linked_str, &|_| {})
        .expect_err("a stale worktree path should abort the delete");
    assert!(
        err.contains("feature"),
        "error should name the branch, got: {err}"
    );

    // Both the branch and the (now detached) worktree survive untouched.
    let branches = repo.git(&["branch", "--list", "feature"]);
    assert!(
        String::from_utf8_lossy(&branches.stdout).contains("feature"),
        "feature branch must survive a refused delete"
    );
    assert!(linked.exists(), "the worktree directory must survive");

    let _ = repo.git(&["worktree", "remove", "--force", linked_str]);
    let _ = std::fs::remove_dir_all(&linked);
}

#[test]
fn move_branch_to_worktree_refuses_when_path_no_longer_holds_the_branch() {
    let repo = TempRepo::new("move-worktree-branch-stale");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["branch", "-M", "main"]);
    std::fs::write(repo.0.join("file.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    repo.git_ok(&["branch", "feature"]);

    let linked = std::env::temp_dir().join(format!(
        "gitlane-move-worktree-branch-stale-linked-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&linked);
    let linked_str = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", linked_str, "feature"]);
    let detach = Command::new("git")
        .arg("-C")
        .arg(&linked)
        .args(["checkout", "--detach", "-q"])
        .output()
        .expect("git detaches the linked worktree");
    assert!(detach.status.success());

    let err = move_branch_to_worktree(
        repo.path(),
        "feature",
        linked_str,
        repo.path(),
        false,
        &|_| {},
    )
    .expect_err("a stale worktree path should abort the move");
    assert!(
        err.contains("feature"),
        "error should name the branch, got: {err}"
    );
    // The current worktree was not switched onto the branch.
    let current = repo.git(&["branch", "--show-current"]);
    assert_eq!(String::from_utf8_lossy(&current.stdout).trim(), "main");

    let _ = repo.git(&["worktree", "remove", "--force", linked_str]);
    let _ = std::fs::remove_dir_all(&linked);
}

// ---- GL-74 worktree handoff: carry + destination picker + conflict routing ----

/// A throwaway linked-worktree directory (lives outside the repo dir, so it needs
/// its own cleanup) that removes itself on drop.
struct LinkedDir(PathBuf);
impl LinkedDir {
    fn new(tag: &str) -> Self {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("gitlane-{tag}-linked-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        LinkedDir(dir)
    }
    fn as_str(&self) -> &str {
        self.0.to_str().unwrap()
    }
}
impl Drop for LinkedDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn git_at(dir: &std::path::Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("git launches in tests")
}

fn git_ok_at(dir: &std::path::Path, args: &[&str]) {
    let out = git_at(dir, args);
    assert!(
        out.status.success(),
        "git {:?} failed\nstderr:\n{}",
        args,
        String::from_utf8_lossy(&out.stderr),
    );
}

/// A repo on `main` (file.txt = "base") with a `feature` branch checked out in a
/// fresh linked worktree — the common starting point for the handoff tests.
fn repo_with_feature_worktree(tag: &str) -> (TempRepo, LinkedDir) {
    let repo = TempRepo::new(tag);
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["branch", "-M", "main"]);
    std::fs::write(repo.0.join("file.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    repo.git_ok(&["branch", "feature"]);

    let linked = LinkedDir::new(tag);
    repo.git_ok(&["worktree", "add", "-q", linked.as_str(), "feature"]);
    (repo, linked)
}

fn is_detached(dir: &std::path::Path) -> bool {
    !git_at(dir, &["symbolic-ref", "--quiet", "HEAD"])
        .status
        .success()
}

// The progress step ids are the UI contract for the hand-off dialog's live
// checklist: assert the happy-path order for a dirty source, and that the
// stash/apply steps never fire when everything is clean (the dialog folds the
// skipped rows in).
#[test]
fn move_branch_to_worktree_reports_progress_steps_in_order() {
    let (repo, linked) = repo_with_feature_worktree("handoff-progress");
    std::fs::write(linked.0.join("file.txt"), "carried\n").unwrap();

    let steps = std::cell::RefCell::new(Vec::new());
    move_branch_to_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        repo.path(),
        true,
        &|s| steps.borrow_mut().push(s),
    )
    .expect("carry handoff");
    assert_eq!(
        steps.into_inner(),
        vec![
            "stashSource",
            "detach",
            "checkout",
            "applySource",
            "finalize"
        ]
    );
}

#[test]
fn move_branch_to_worktree_skips_stash_steps_when_clean() {
    let (repo, linked) = repo_with_feature_worktree("handoff-progress-clean");

    let steps = std::cell::RefCell::new(Vec::new());
    move_branch_to_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        repo.path(),
        true,
        &|s| steps.borrow_mut().push(s),
    )
    .expect("clean handoff");
    assert_eq!(steps.into_inner(), vec!["detach", "checkout", "finalize"]);
}

#[test]
fn move_branch_to_worktree_carries_dirty_source_changes() {
    let (repo, linked) = repo_with_feature_worktree("handoff-carry");
    // The AI-worktree case: uncommitted work in the linked (source) worktree.
    std::fs::write(linked.0.join("file.txt"), "carried\n").unwrap();
    std::fs::write(linked.0.join("new.txt"), "brand new\n").unwrap(); // untracked rides along

    let msg = move_branch_to_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        repo.path(),
        true,
        &|_| {},
    )
    .expect("carry handoff");
    assert!(
        msg.contains("feature"),
        "message should name the branch: {msg}"
    );

    // The destination (main worktree) is now on feature with the carried work.
    let current = repo.git(&["branch", "--show-current"]);
    assert_eq!(String::from_utf8_lossy(&current.stdout).trim(), "feature");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("file.txt")).unwrap(),
        "carried\n"
    );
    assert!(
        repo.0.join("new.txt").exists(),
        "untracked file should carry"
    );
    // Source worktree left detached; no stashes linger.
    assert!(is_detached(&linked.0), "source worktree should be detached");
    let stashes = repo.git(&["stash", "list"]);
    assert!(
        String::from_utf8_lossy(&stashes.stdout).trim().is_empty(),
        "carry should drop its stashes on success"
    );
}

#[test]
fn move_branch_to_worktree_refuses_dirty_source_without_carry() {
    let (repo, linked) = repo_with_feature_worktree("handoff-nocarry");
    std::fs::write(linked.0.join("file.txt"), "dirty\n").unwrap();

    let err = move_branch_to_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        repo.path(),
        false,
        &|_| {},
    )
    .expect_err("a dirty source without carry should be refused");
    assert!(err.contains("uncommitted"), "error should explain: {err}");

    // Nothing moved or stashed: source still on feature, destination still on main.
    assert!(!is_detached(&linked.0), "source must not be detached");
    let current = repo.git(&["branch", "--show-current"]);
    assert_eq!(String::from_utf8_lossy(&current.stdout).trim(), "main");
    let stashes = repo.git(&["stash", "list"]);
    assert!(String::from_utf8_lossy(&stashes.stdout).trim().is_empty());
}

#[test]
fn move_branch_to_worktree_reapplies_dirty_destination() {
    let (repo, linked) = repo_with_feature_worktree("handoff-dirtydest");
    // Destination (main worktree) carries its own uncommitted work on a file that
    // doesn't diverge between branches, so it re-applies cleanly after the switch.
    std::fs::write(repo.0.join("dest-wip.txt"), "dest work\n").unwrap();

    let msg = move_branch_to_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        repo.path(),
        true,
        &|_| {},
    )
    .expect("handoff onto a dirty destination");
    assert!(
        msg.contains("feature"),
        "message should name the branch: {msg}"
    );

    let current = repo.git(&["branch", "--show-current"]);
    assert_eq!(String::from_utf8_lossy(&current.stdout).trim(), "feature");
    // The destination's own prior work survives the switch.
    assert_eq!(
        std::fs::read_to_string(repo.0.join("dest-wip.txt")).unwrap(),
        "dest work\n"
    );
    let stashes = repo.git(&["stash", "list"]);
    assert!(
        String::from_utf8_lossy(&stashes.stdout).trim().is_empty(),
        "a clean re-apply should drop the destination stash"
    );
}

#[test]
fn move_branch_to_worktree_restores_the_source_stash_when_dest_stash_fails() {
    let (repo, linked) = repo_with_feature_worktree("handoff-destfail");
    // Source (linked) is dirty → its changes are stashed first.
    std::fs::write(linked.0.join("file.txt"), "carried\n").unwrap();
    // Destination (main) is dirty → its stash will be attempted, but we sabotage
    // it by holding the destination's index lock: `git status` still reads (so we
    // reach the stash step), but `git stash push` there fails on the lock.
    std::fs::write(repo.0.join("file.txt"), "dest wip\n").unwrap();
    let lock = repo.0.join(".git").join("index.lock");
    std::fs::write(&lock, b"").unwrap();

    let err = move_branch_to_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        repo.path(),
        true,
        &|_| {},
    )
    .expect_err("a failed destination stash should abort the handoff");
    let _ = std::fs::remove_file(&lock); // let the TempRepo Drop clean up
    assert!(!err.is_empty(), "expected a git error, got empty");

    // The source's carried changes were restored (not stranded in a stash), and the
    // structural move never happened.
    assert_eq!(
        std::fs::read_to_string(linked.0.join("file.txt")).unwrap(),
        "carried\n",
        "the source's changes must be restored on rollback"
    );
    assert!(
        !is_detached(&linked.0),
        "source must not be detached after a rollback"
    );
    let current = repo.git(&["branch", "--show-current"]);
    assert_eq!(
        String::from_utf8_lossy(&current.stdout).trim(),
        "main",
        "the destination must not have switched branches"
    );
    let stashes = repo.git(&["stash", "list"]);
    assert!(
        String::from_utf8_lossy(&stashes.stdout).trim().is_empty(),
        "no stash should linger after the rollback"
    );
}

/// Set up a handoff whose destination re-apply genuinely conflicts: `feature`
/// changes file.txt one way (committed), the destination has an uncommitted change
/// to the same file the other way. Returns the repo (its linked worktree is kept
/// alive by the returned guard).
fn handoff_into_conflict(tag: &str) -> (TempRepo, LinkedDir, String) {
    let (repo, linked) = repo_with_feature_worktree(tag);
    // Give feature a divergent commit to file.txt (done inside the linked worktree
    // so the source stays clean).
    std::fs::write(linked.0.join("file.txt"), "feature\n").unwrap();
    git_ok_at(&linked.0, &["commit", "-q", "-am", "feature change"]);
    // Destination has a conflicting uncommitted change to the same file.
    std::fs::write(repo.0.join("file.txt"), "destination wip\n").unwrap();

    let msg = move_branch_to_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        repo.path(),
        true,
        &|_| {},
    )
    .expect("handoff should land structurally even when the carry conflicts");
    (repo, linked, msg)
}

#[test]
fn move_branch_to_worktree_routes_carry_conflict_and_continues() {
    let (repo, _linked, msg) = handoff_into_conflict("handoff-conflict");
    assert!(
        msg.contains("resolve"),
        "message should ask to resolve: {msg}"
    );

    // The conflict surfaces as a "carry" operation (marker + unmerged entries).
    let status = crate::git::conflicts::operation_status(repo.path()).expect("operation status");
    assert_eq!(status.kind, "carry");
    assert!(!status.can_skip);
    assert!(
        status.conflicts.iter().any(|c| c.path == "file.txt"),
        "file.txt should be conflicted: {:?}",
        status.conflicts
    );

    // Resolve + stage the conflict.
    std::fs::write(repo.0.join("file.txt"), "resolved\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    // GL-74 P1: staging the last conflict clears the index conflicts, but the
    // carry must STAY active (its recovery stash is still on the stack) so the
    // frontend's worktree refresh doesn't drop "Finish carry" before it can run.
    let resolved = crate::git::conflicts::operation_status(repo.path()).expect("status resolved");
    assert_eq!(
        resolved.kind, "carry",
        "carry must survive resolving the last conflict"
    );
    assert!(
        resolved.conflicts.is_empty(),
        "no conflicts remain once staged"
    );

    // Finish the carry.
    let done = continue_operation(repo.path(), "carry", None, None).expect("continue carry");
    assert!(
        done.contains("Carried"),
        "unexpected continue message: {done}"
    );

    // Marker cleared (no operation) and the kept stash dropped.
    let after = crate::git::conflicts::operation_status(repo.path()).expect("status after");
    assert_eq!(after.kind, "none");
    let stashes = repo.git(&["stash", "list"]);
    assert!(
        String::from_utf8_lossy(&stashes.stdout).trim().is_empty(),
        "continue should drop the kept stash"
    );
}

#[test]
fn abort_carry_discards_the_merge_but_preserves_the_stash() {
    let (repo, _linked, _msg) = handoff_into_conflict("handoff-abort");
    assert_eq!(
        crate::git::conflicts::operation_status(repo.path())
            .unwrap()
            .kind,
        "carry"
    );

    let done = abort_operation(repo.path(), "carry").expect("abort carry");
    assert!(
        done.contains("preserved"),
        "unexpected abort message: {done}"
    );

    // Operation cleared; working tree back at the branch tip; the stash kept.
    let after = crate::git::conflicts::operation_status(repo.path()).expect("status after abort");
    assert_eq!(after.kind, "none");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("file.txt")).unwrap(),
        "feature\n"
    );
    let stashes = repo.git(&["stash", "list"]);
    assert_eq!(
        String::from_utf8_lossy(&stashes.stdout).lines().count(),
        1,
        "abort should preserve the destination's stashed changes"
    );
}

#[test]
fn stale_handoff_marker_is_swept_when_its_stashes_are_gone() {
    let (repo, _linked, _msg) = handoff_into_conflict("handoff-stale");
    assert_eq!(
        crate::git::conflicts::operation_status(repo.path())
            .unwrap()
            .kind,
        "carry"
    );

    // The carry's recovery stash disappears (finished/aborted/dropped outside the
    // app), leaving only the marker. A stale marker must self-heal to "none" and
    // not keep claiming (or later mislabel) the worktree as a carry.
    repo.git(&["stash", "clear"]);
    assert_eq!(
        crate::git::conflicts::operation_status(repo.path())
            .unwrap()
            .kind,
        "none",
        "a marker whose stashes are gone must not report a carry"
    );
    // The marker file was swept, so a subsequent read is also clean.
    assert_eq!(
        crate::git::conflicts::operation_status(repo.path())
            .unwrap()
            .kind,
        "none"
    );
}

#[test]
fn move_branch_to_worktree_refuses_a_source_with_unresolved_conflicts() {
    let (repo, linked) = repo_with_feature_worktree("handoff-unmerged");
    let l = linked.0.as_path();
    // Leave the linked (source) worktree mid-conflict: commit a change on feature,
    // a divergent one on a sibling, then merge → unresolved conflict on feature.
    std::fs::write(l.join("file.txt"), "AAA\n").unwrap();
    git_ok_at(l, &["commit", "-q", "-am", "A"]);
    git_ok_at(l, &["checkout", "-q", "-b", "sibling", "HEAD~1"]);
    std::fs::write(l.join("file.txt"), "BBB\n").unwrap();
    git_ok_at(l, &["commit", "-q", "-am", "B"]);
    git_ok_at(l, &["checkout", "-q", "feature"]);
    let merge = git_at(l, &["merge", "sibling"]);
    assert!(
        !merge.status.success(),
        "merge should conflict for the test setup"
    );

    let err = move_branch_to_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        repo.path(),
        true,
        &|_| {},
    )
    .expect_err("a source mid-conflict should be refused up front");
    assert!(
        err.contains("unresolved conflicts"),
        "error should explain the conflict, got: {err}"
    );
    // Nothing was stashed or moved by the refused handoff.
    let stashes = repo.git(&["stash", "list"]);
    assert!(String::from_utf8_lossy(&stashes.stdout).trim().is_empty());
}

#[test]
fn worktrees_flags_bare_and_prunable_targets_and_handoff_refuses_a_bare_destination() {
    // The bare-repo + per-branch-worktree layout: `git worktree list` reports the
    // bare repo (no working tree) and any prunable (deleted) worktree. Neither can
    // receive a branch checkout, so `worktrees()` must flag them and the handoff
    // must refuse a bare destination up front (before detaching the source).
    let seed = TempRepo::new("wt-attrs-seed");
    seed.git_ok(&["init", "-q"]);
    seed.git_ok(&["config", "user.name", "GitLane Test"]);
    seed.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(seed.0.join("f.txt"), "x\n").unwrap();
    seed.git_ok(&["add", "f.txt"]);
    seed.git_ok(&["commit", "-q", "-m", "init"]);
    seed.git_ok(&["branch", "feature"]);

    let bare = TempRepo::new("wt-attrs-bare");
    let clone = Command::new("git")
        .args(["clone", "-q", "--bare", seed.path(), bare.path()])
        .output()
        .expect("git clone --bare");
    assert!(
        clone.status.success(),
        "bare clone failed: {}",
        String::from_utf8_lossy(&clone.stderr)
    );

    let linked = LinkedDir::new("wt-attrs-linked");
    git_ok_at(
        bare.0.as_path(),
        &["worktree", "add", "-q", linked.as_str(), "feature"],
    );
    let gone = LinkedDir::new("wt-attrs-gone");
    git_ok_at(
        bare.0.as_path(),
        &["worktree", "add", "-q", "--detach", gone.as_str()],
    );
    std::fs::remove_dir_all(&gone.0).unwrap(); // now prunable

    let list = worktrees(bare.path()).expect("list worktrees");
    let main_entry = list.iter().find(|w| w.is_main).expect("main entry");
    assert!(main_entry.bare, "the bare main should be flagged bare");
    let feature = list
        .iter()
        .find(|w| w.branch.as_deref() == Some("feature"))
        .expect("feature worktree");
    assert!(
        !feature.bare && !feature.prunable,
        "the linked feature worktree is a valid target"
    );
    assert!(
        list.iter().any(|w| w.prunable),
        "the deleted worktree should be flagged prunable"
    );

    // Handing the feature branch off *into the bare repo* is refused up front.
    let err = move_branch_to_worktree(
        bare.path(),
        "feature",
        linked.as_str(),
        bare.path(),
        true,
        &|_| {},
    )
    .expect_err("handoff into a bare repo should be refused");
    assert!(err.contains("bare repository"), "got: {err}");
    // The source was not detached by the refused handoff.
    let source_head = git_at(&linked.0, &["symbolic-ref", "--quiet", "--short", "HEAD"]);
    assert_eq!(
        String::from_utf8_lossy(&source_head.stdout).trim(),
        "feature",
        "source must still be on its branch after a refused handoff"
    );
}

#[test]
fn remove_worktree_force_overrides_a_lock() {
    let repo = TempRepo::new("wt-locked");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("f.txt"), "x\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-locked");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    repo.git_ok(&["worktree", "lock", linked.as_str()]);

    // `worktrees()` flags the lock.
    let list = worktrees(repo.path()).expect("list worktrees");
    assert!(
        list.iter().any(|w| !w.is_main && w.locked),
        "the linked worktree should be flagged locked: {list:?}"
    );

    // An unforced remove refuses (git's "locked working tree" error); a forced
    // remove overrides the lock because the backend supplies the second --force.
    assert!(
        remove_worktree(repo.path(), linked.as_str(), false).is_err(),
        "an unforced remove must not silently override a lock"
    );
    remove_worktree(repo.path(), linked.as_str(), true).expect("force-remove a locked worktree");
    assert!(
        !linked.0.exists(),
        "the locked worktree directory should be gone after a forced remove"
    );
}

#[test]
fn apply_hunk_stages_one_unstaged_hunk_with_unusual_path() {
    let repo = TempRepo::new("stage-hunk-unusual-path");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    let file = "space ü #.txt";
    std::fs::write(
        repo.0.join(file),
        "one\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\ntwelve\n",
    )
    .unwrap();
    repo.git_ok(&["add", file]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(
        repo.0.join(file),
        "ONE\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\nTWELVE\n",
    )
    .unwrap();

    apply_hunk(
        repo.path(),
        file,
        false,
        0,
        "@@ -1,4 +1,4 @@",
        "-one\n+ONE\n 2\n 3\n 4",
    )
    .expect("stage first hunk");

    let cached = repo.git(&["diff", "--cached", "--", file]);
    let cached_text = String::from_utf8_lossy(&cached.stdout);
    assert!(cached_text.contains("+ONE"));
    assert!(!cached_text.contains("+TWELVE"));
    let unstaged = repo.git(&["diff", "--", file]);
    let unstaged_text = String::from_utf8_lossy(&unstaged.stdout);
    assert!(!unstaged_text.contains("+ONE"));
    assert!(unstaged_text.contains("+TWELVE"));
}

#[test]
fn apply_patch_diff_args_match_rendered_diff_defaults() {
    assert_eq!(
        patch_diff_args(false, "file.txt"),
        vec![
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--no-indent-heuristic",
            "--diff-algorithm=myers",
            "--unified=3",
            "--inter-hunk-context=0",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--",
            "file.txt",
        ]
    );
    assert_eq!(
        patch_diff_args(true, "file.txt"),
        vec![
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--no-indent-heuristic",
            "--diff-algorithm=myers",
            "--unified=3",
            "--inter-hunk-context=0",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--cached",
            "--",
            "file.txt",
        ]
    );
}

#[test]
fn apply_hunk_allows_different_function_context_text() {
    let repo = TempRepo::new("hunk-function-context");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\nthree\nfour\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join("file.txt"), "ONE\ntwo\nthree\nfour\n").unwrap();

    apply_hunk(
        repo.path(),
        "file.txt",
        false,
        0,
        "@@ -1,4 +1,4 @@ different context",
        "-one\n+ONE\n two\n three\n four",
    )
    .expect("stage hunk");

    let cached = repo.git(&["diff", "--cached", "--", "file.txt"]);
    assert!(String::from_utf8_lossy(&cached.stdout).contains("+ONE"));
}

#[test]
fn apply_hunk_unstages_one_staged_hunk() {
    let repo = TempRepo::new("unstage-hunk");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(
        repo.0.join("file.txt"),
        "one\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\ntwelve\n",
    )
    .unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(
        repo.0.join("file.txt"),
        "ONE\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\nTWELVE\n",
    )
    .unwrap();
    repo.git_ok(&["add", "file.txt"]);

    apply_hunk(
        repo.path(),
        "file.txt",
        true,
        0,
        "@@ -1,4 +1,4 @@",
        "-one\n+ONE\n 2\n 3\n 4",
    )
    .expect("unstage first hunk");

    let cached = repo.git(&["diff", "--cached", "--", "file.txt"]);
    let cached_text = String::from_utf8_lossy(&cached.stdout);
    assert!(!cached_text.contains("+ONE"));
    assert!(cached_text.contains("+TWELVE"));
    let unstaged = repo.git(&["diff", "--", "file.txt"]);
    let unstaged_text = String::from_utf8_lossy(&unstaged.stdout);
    assert!(unstaged_text.contains("+ONE"));
}

#[test]
fn apply_hunk_stages_deleted_file_hunk() {
    let repo = TempRepo::new("stage-deleted-hunk");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("gone.txt"), "one\ntwo\nthree\n").unwrap();
    repo.git_ok(&["add", "gone.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::remove_file(repo.0.join("gone.txt")).unwrap();

    apply_hunk(
        repo.path(),
        "gone.txt",
        false,
        0,
        "@@ -1,3 +0,0 @@",
        "-one\n-two\n-three",
    )
    .expect("stage deletion hunk");

    let status = repo.git(&["diff", "--cached", "--name-status", "--", "gone.txt"]);
    assert_eq!(
        String::from_utf8_lossy(&status.stdout).trim(),
        "D\tgone.txt"
    );
}

#[test]
fn stage_files_stages_a_folder_including_a_deletion() {
    let repo = TempRepo::new("stage-files-folder");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::create_dir_all(repo.0.join("src/app")).unwrap();
    std::fs::write(repo.0.join("src/app/keep.txt"), "one\n").unwrap();
    std::fs::write(repo.0.join("src/app/gone.txt"), "bye\n").unwrap();
    std::fs::write(repo.0.join("root.txt"), "root\n").unwrap();
    repo.git_ok(&["add", "-A"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);

    // A folder with an edit + a deletion, plus an unrelated edit outside it.
    std::fs::write(repo.0.join("src/app/keep.txt"), "ONE\n").unwrap();
    std::fs::remove_file(repo.0.join("src/app/gone.txt")).unwrap();
    std::fs::write(repo.0.join("root.txt"), "ROOT\n").unwrap();

    // Roll up just the folder's files (the bulk-stage callback passes explicit paths).
    stage_files(
        repo.path(),
        &["src/app/keep.txt".into(), "src/app/gone.txt".into()],
    )
    .expect("stage the folder's files");

    let staged = repo.git(&["diff", "--cached", "--name-status"]);
    let staged_text = String::from_utf8_lossy(&staged.stdout);
    // The folder's edit and deletion are both staged (-A reaches removals too)…
    assert!(staged_text.contains("M\tsrc/app/keep.txt"), "{staged_text}");
    assert!(staged_text.contains("D\tsrc/app/gone.txt"), "{staged_text}");
    // …and the file outside the folder is left in the working tree.
    assert!(!staged_text.contains("root.txt"), "{staged_text}");
}

#[test]
fn stage_files_with_no_paths_is_a_noop() {
    let repo = TempRepo::new("stage-files-empty");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("root.txt"), "root\n").unwrap();

    // Empty set returns Ok without invoking git (mirrors unstage_files).
    assert_eq!(stage_files(repo.path(), &[]).unwrap(), "");
    let staged = repo.git(&["diff", "--cached", "--name-only"]);
    assert!(String::from_utf8_lossy(&staged.stdout).trim().is_empty());
}

#[test]
fn apply_hunk_rejects_stale_hunk_header() {
    let repo = TempRepo::new("stale-hunk");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join("file.txt"), "ONE\ntwo\n").unwrap();

    let err = apply_hunk(repo.path(), "file.txt", false, 0, "@@ -9,1 +9,1 @@", "").unwrap_err();

    assert!(err.contains("changed on disk"));
}

#[test]
fn apply_hunk_rejects_stale_hunk_body() {
    let repo = TempRepo::new("stale-hunk-body");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join("file.txt"), "ONE\ntwo\n").unwrap();

    // Correct @@ range but a body the diff never produced (the file changed on
    // disk since it was displayed) → rejected before anything is staged.
    let err = apply_hunk(
        repo.path(),
        "file.txt",
        false,
        0,
        "@@ -1,2 +1,2 @@",
        "-stale\n+content\n two",
    )
    .unwrap_err();

    assert!(err.contains("changed on disk"));
}

#[test]
fn apply_hunk_patch_surfaces_git_rejection() {
    let repo = TempRepo::new("reject-hunk-patch");
    repo.git_ok(&["init", "-q"]);

    let err = apply_hunk_patch(repo.path(), "not a patch\n", false).unwrap_err();

    assert!(!err.is_empty());
}

#[test]
fn apply_line_stages_one_added_line_with_unusual_path() {
    let repo = TempRepo::new("stage-line-add-unusual-path");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    let file = "line space ü #.txt";
    std::fs::write(repo.0.join(file), "one\ntwo\nthree\nfour\n").unwrap();
    repo.git_ok(&["add", file]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join(file), "one\ntwo\ninserted\nthree\nfour\n").unwrap();

    apply_line(
        repo.path(),
        file,
        false,
        0,
        2,
        "add",
        "inserted",
        None,
        Some(3),
    )
    .expect("stage added line");

    let cached = repo.git(&["diff", "--cached", "--", file]);
    let cached_text = String::from_utf8_lossy(&cached.stdout);
    assert!(cached_text.contains("+inserted"));
    let unstaged = repo.git(&["diff", "--", file]);
    let unstaged_text = String::from_utf8_lossy(&unstaged.stdout);
    assert!(!unstaged_text.contains("+inserted"));
}

#[test]
fn apply_line_stages_one_deleted_line() {
    let repo = TempRepo::new("stage-line-delete");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\nthree\nfour\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\nfour\n").unwrap();

    apply_line(
        repo.path(),
        "file.txt",
        false,
        0,
        2,
        "del",
        "three",
        Some(3),
        None,
    )
    .expect("stage deleted line");

    let cached = repo.git(&["diff", "--cached", "--", "file.txt"]);
    assert!(String::from_utf8_lossy(&cached.stdout).contains("-three"));
    let unstaged = repo.git(&["diff", "--", "file.txt"]);
    assert!(!String::from_utf8_lossy(&unstaged.stdout).contains("-three"));
}

#[test]
fn apply_line_unstages_one_staged_line() {
    let repo = TempRepo::new("unstage-line");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\nthree\nfour\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\ninserted\nthree\nfour\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);

    apply_line(
        repo.path(),
        "file.txt",
        true,
        0,
        2,
        "add",
        "inserted",
        None,
        Some(3),
    )
    .expect("unstage added line");

    let cached = repo.git(&["diff", "--cached", "--", "file.txt"]);
    assert!(!String::from_utf8_lossy(&cached.stdout).contains("+inserted"));
    let unstaged = repo.git(&["diff", "--", "file.txt"]);
    assert!(String::from_utf8_lossy(&unstaged.stdout).contains("+inserted"));
}

#[test]
fn apply_line_rejects_stale_line_state() {
    let repo = TempRepo::new("stale-line");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\nthree\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\ninserted\nthree\n").unwrap();

    let err = apply_line(
        repo.path(),
        "file.txt",
        false,
        0,
        2,
        "add",
        "different",
        None,
        Some(3),
    )
    .unwrap_err();

    assert!(err.contains("changed on disk"));
}

#[test]
fn apply_line_preserves_no_newline_at_eof_marker() {
    let repo = TempRepo::new("stage-line-no-newline");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join("file.txt"), b"one\nlast").unwrap();

    apply_line(
        repo.path(),
        "file.txt",
        false,
        0,
        1,
        "add",
        "last",
        None,
        Some(2),
    )
    .expect("stage no-newline line");

    let blob = repo.git(&["show", ":file.txt"]);
    assert_eq!(blob.stdout, b"one\nlast");
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
fn reflog_entries_expose_recovery_commits() {
    let repo = TempRepo::new("reflog");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git(&["commit", "-qam", "two"]);
    repo.git(&["reset", "--hard", "HEAD~1"]);

    let entries = reflog_entries(repo.path(), 12).expect("reflog entries");
    assert!(entries.iter().any(|entry| entry.subject.contains("reset")));
    assert!(entries
        .iter()
        .any(|entry| entry.short_selector.contains("HEAD@{")));
}

#[test]
fn reflog_entries_use_reflog_time_not_commit_time() {
    let repo = TempRepo::new("reflog-time");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"old\n").unwrap();
    repo.git(&["add", "f.txt"]);
    let old_timestamp = 946_684_800_i64;
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo.0)
        .args(["commit", "-qm", "old"])
        .env("GIT_AUTHOR_DATE", format!("@{old_timestamp} +0000"))
        .env("GIT_COMMITTER_DATE", format!("@{old_timestamp} +0000"))
        .output()
        .expect("git launches in tests");
    assert!(
        out.status.success(),
        "old commit failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    std::fs::write(repo.0.join("f.txt"), b"new\n").unwrap();
    repo.git(&["commit", "-qam", "new"]);
    repo.git(&["reset", "--hard", "HEAD~1"]);

    let entries = reflog_entries(repo.path(), 12).expect("reflog entries");
    let reset = entries
        .iter()
        .find(|entry| entry.subject.contains("reset"))
        .expect("reset reflog entry");
    assert!(
        reset.timestamp > old_timestamp,
        "reset timestamp should be the reflog event time, not old commit time: {:?}",
        reset
    );
}

#[test]
fn reflog_entries_scope_excludes_remote_and_stash() {
    let repo = TempRepo::new("reflog-scope");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "base"]);
    // A remote-tracking ref update and a stash both create reflog entries that
    // `git log -g --all` would surface but the recovery list must not.
    repo.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
    std::fs::write(repo.0.join("f.txt"), b"dirty\n").unwrap();
    repo.git(&["stash", "-q"]);

    let entries = reflog_entries(repo.path(), 50).expect("reflog entries");
    assert!(!entries.is_empty(), "HEAD/branch entries should remain");
    assert!(
        entries
            .iter()
            .all(|e| !e.selector.contains("remotes") && !e.selector.contains("stash")),
        "remote-tracking and stash reflog entries must be excluded: {:?}",
        entries.iter().map(|e| &e.selector).collect::<Vec<_>>()
    );
}

#[test]
fn reflog_entries_on_unborn_repo_is_empty_not_error() {
    // An unborn HEAD makes `git log -g HEAD …` fatal, so `reflog_entries`
    // short-circuits on the `rev-parse --verify HEAD` pre-check and returns an
    // empty list — the recovery dialog shows its "No reflog entries" state.
    let repo = TempRepo::new("reflog-empty");
    repo.git(&["init", "-q", "-b", "main"]);
    let entries = reflog_entries(repo.path(), 12).expect("reflog entries on empty repo");
    assert!(entries.is_empty());
}

#[test]
fn reflog_entries_with_no_reflog_is_empty_not_error() {
    // A committed repo whose reflog was pruned/disabled: HEAD resolves, but
    // `git log -g HEAD --branches` exits 0 with no output (it does NOT error),
    // so the read yields an empty list rather than surfacing a git failure.
    let repo = TempRepo::new("reflog-pruned");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "base"]);
    std::fs::remove_dir_all(repo.0.join(".git/logs")).unwrap();

    let entries = reflog_entries(repo.path(), 12).expect("reflog entries with no reflog");
    assert!(entries.is_empty());
}

#[test]
fn reset_preview_lists_commits_and_recovery_warning() {
    let repo = TempRepo::new("reset-preview");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git(&["commit", "-qam", "two"]);

    let preview = preview_reset(repo.path(), "HEAD~1", "hard", "HEAD").expect("preview");
    assert!(preview.summary.contains("hard"));
    assert!(preview.details.iter().any(|line| line.contains("two")));
    assert!(preview.warnings.iter().any(|line| line.contains("reflog")));
}

#[test]
fn reset_preview_anchors_on_the_source_ref_not_head() {
    // A reset of a *non-current* branch (drag a branch onto a commit) checks
    // that branch out first, so the impacted commits are `target..source`,
    // not `target..HEAD`. The preview must reflect the branch being reset.
    let repo = TempRepo::new("reset-source-ref");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "base"]);
    // A feature branch with a commit that HEAD (main) does not have.
    repo.git(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("f.txt"), b"feature\n").unwrap();
    repo.git(&["commit", "-qam", "feature-only"]);
    // Back on main so HEAD != the branch being reset.
    repo.git(&["checkout", "-q", "main"]);

    // Resetting `feature` to base must list feature-only, even though HEAD=main.
    let on_source = preview_reset(repo.path(), "main", "mixed", "feature").expect("preview source");
    assert!(on_source
        .details
        .iter()
        .any(|line| line.contains("feature-only")));
    // Anchored on HEAD (main) the same range is empty — proves the fix matters.
    let on_head = preview_reset(repo.path(), "main", "mixed", "HEAD").expect("preview head");
    assert!(!on_head
        .details
        .iter()
        .any(|line| line.contains("feature-only")));
}

#[test]
fn reset_preview_source_uses_branch_not_same_named_tag() {
    let repo = TempRepo::new("reset-ambig");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "one"]);
    // Branch `dup` carries an extra commit; tag `dup` stays at base (== main).
    repo.git(&["branch", "dup"]);
    repo.git(&["checkout", "-q", "dup"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git(&["commit", "-qam", "dup-only"]);
    repo.git(&["checkout", "-q", "main"]);
    repo.git(&["tag", "dup", "main"]);

    // Resetting branch `dup` to main: impact is main..refs/heads/dup = dup-only.
    // A bare `dup` would resolve to the tag (== main) and show nothing.
    let preview = preview_reset(repo.path(), "main", "mixed", "dup").expect("preview");
    assert!(
        preview.details.iter().any(|line| line.contains("dup-only")),
        "reset source must resolve to the branch, not the same-named tag: {:?}",
        preview.details
    );
}

#[test]
fn reset_preview_target_uses_branch_not_same_named_tag() {
    // The write path (`reset`) qualifies an ambiguous target to refs/heads/; the
    // preview must resolve the same ref so the confirm dialog can't describe
    // moving to the tag while the reset lands on the branch (GL-120 review).
    let repo = TempRepo::new("reset-target-ambig");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "one"]);
    let base_short = rev_parse(&repo, "HEAD")[..7].to_string();
    // Branch `dup` carries an extra commit; tag `dup` stays at base.
    repo.git(&["branch", "dup"]);
    repo.git(&["checkout", "-q", "dup"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git(&["commit", "-qam", "dup-only"]);
    let dup_tip_short = rev_parse(&repo, "HEAD")[..7].to_string();
    repo.git(&["checkout", "-q", "main"]);
    repo.git(&["tag", "dup", "main"]);

    // Resetting HEAD (main, at base) to `dup`: the target must resolve to the
    // branch tip, so the preview says HEAD moves there — not to the tag at base.
    let preview = preview_reset(repo.path(), "dup", "mixed", "HEAD").expect("preview");
    assert!(
        preview
            .details
            .iter()
            .any(|line| line.contains(&dup_tip_short)),
        "preview target must resolve to the branch tip {dup_tip_short}, not the tag: {:?}",
        preview.details
    );
    assert!(
        !preview
            .details
            .iter()
            .any(|line| line.contains(&format!("move to {base_short}"))),
        "preview must not describe moving to the same-named tag at base {base_short}: {:?}",
        preview.details
    );
}

#[test]
fn reset_preview_fails_closed_on_unresolvable_refs() {
    let repo = TempRepo::new("reset-bad-refs");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "base"]);

    // A bogus target or source must error (fail closed) rather than render a
    // confident empty preview.
    assert!(preview_reset(repo.path(), "does-not-exist", "mixed", "HEAD").is_err());
    assert!(preview_reset(repo.path(), "HEAD", "mixed", "does-not-exist").is_err());
}

#[test]
fn discard_all_preview_warns_about_untracked_limits() {
    let repo = TempRepo::new("discard-preview");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("tracked.txt"), b"one\n").unwrap();
    repo.git(&["add", "tracked.txt"]);
    repo.git(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("tracked.txt"), b"two\n").unwrap();
    std::fs::write(repo.0.join("new.txt"), b"new\n").unwrap();

    let preview = preview_discard_all(repo.path()).expect("preview");
    assert!(preview
        .details
        .iter()
        .any(|line| line.contains("tracked.txt")));
    assert!(preview.details.iter().any(|line| line.contains("new.txt")));
    assert!(preview
        .warnings
        .iter()
        .any(|line| line.contains("Untracked files")));
    assert!(preview
        .warnings
        .iter()
        .any(|line| line.contains("empty directories are preserved")));
}

#[test]
fn discard_all_preview_lists_preserved_nested_git_repositories() {
    let repo = repo_with_file("discard-preview-nested-repo", "tracked.txt", b"base\n");
    std::fs::create_dir(repo.0.join("nested")).unwrap();
    repo.git_ok(&["-C", "nested", "init", "-q"]);
    std::fs::write(repo.0.join("nested/file.txt"), "nested\n").unwrap();

    let preview = preview_discard_all(repo.path()).expect("preview");

    assert!(preview.summary.contains("removable untracked"));
    assert!(preview
        .details
        .iter()
        .any(|line| line.contains("Nested Git repositories") && line.contains("nested/")));
    assert!(preview
        .warnings
        .iter()
        .any(|line| line.contains("protected") && line.contains("will remain")));
}

#[test]
fn discard_all_preview_fails_closed_on_non_repo() {
    // A path that isn't a git repo must error, not report "already clean".
    let dir = TempRepo::new("discard-non-repo");
    assert!(preview_discard_all(dir.path()).is_err());
}

#[test]
fn delete_branch_preview_uses_branch_not_same_named_tag() {
    let repo = TempRepo::new("delete-ambig");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git(&["commit", "-qam", "two"]);
    // Branch `dup` at the first commit, tag `dup` at HEAD. A bare `dup`
    // resolves to the tag (ref precedence); the preview must use the branch.
    repo.git(&["branch", "dup", "HEAD~1"]);
    repo.git(&["tag", "dup", "HEAD"]);
    let branch_tip =
        String::from_utf8(repo.git(&["rev-parse", "--short", "refs/heads/dup"]).stdout).unwrap();
    let branch_tip = branch_tip.trim();

    let preview = preview_delete_branch(repo.path(), "dup").expect("preview");
    assert!(
        preview.details.iter().any(|line| line.contains(branch_tip)),
        "preview must report the branch tip {branch_tip}, not the tag: {:?}",
        preview.details
    );
}

#[test]
fn force_push_preview_fails_closed_for_missing_branch() {
    let (repo, _) = repo_with_base_commit("force-push-missing");
    assert!(preview_force_push(repo.path(), "no-such-branch").is_err());
}

#[test]
fn reset_preview_hard_lists_tracked_and_untracked_obstructions_only() {
    let repo = TempRepo::new("reset-hard-untracked");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("tracked.txt"), b"one\n").unwrap();
    std::fs::write(repo.0.join("restored.txt"), b"target\n").unwrap();
    repo.git(&["add", "tracked.txt", "restored.txt"]);
    repo.git(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("tracked.txt"), b"two\n").unwrap();
    repo.git(&["rm", "-q", "restored.txt"]);
    repo.git(&["commit", "-am", "two"]);
    // Dirty the tree: a tracked edit is lost by --hard, an ordinary untracked
    // file is left in place, and an untracked file that blocks a target-tree
    // tracked path can be overwritten/deleted by reset --hard.
    std::fs::write(repo.0.join("tracked.txt"), b"dirty\n").unwrap();
    std::fs::write(repo.0.join("untracked.txt"), b"keep\n").unwrap();
    std::fs::write(repo.0.join("restored.txt"), b"obstruct\n").unwrap();

    let preview = preview_reset(repo.path(), "HEAD~1", "hard", "HEAD").expect("preview");
    assert!(preview
        .warnings
        .iter()
        .any(|line| line.contains("tracked changes that will be lost")
            && line.contains("tracked.txt")));
    let full = format!(
        "{}{}",
        preview.details.join("\n"),
        preview.warnings.join("\n")
    );
    assert!(
        full.contains("restored.txt"),
        "hard-reset preview must list untracked target obstructions: {full}"
    );
    assert!(
        !full.contains("untracked.txt"),
        "hard-reset preview must not list ordinary untracked files: {full}"
    );
}

#[test]
fn delete_branch_preview_lists_unmerged_commits() {
    let repo = TempRepo::new("delete-branch-preview");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "base"]);
    // A feature branch with a commit that is not reachable from HEAD (main).
    repo.git(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("f.txt"), b"feature\n").unwrap();
    repo.git(&["commit", "-qam", "feature-work"]);
    repo.git(&["checkout", "-q", "main"]);

    let preview = preview_delete_branch(repo.path(), "feature").expect("preview");
    assert!(preview.summary.contains("feature"));
    assert!(preview
        .details
        .iter()
        .any(|line| line.contains("feature-work")));
    // A non-existent branch fails closed rather than showing an "unknown" tip.
    assert!(preview_delete_branch(repo.path(), "ghost").is_err());
}

#[test]
fn delete_remote_branch_preview_warns_unrecoverable() {
    let (repo, head) = repo_with_base_commit("delete-remote-preview");
    // Seed the remote-tracking ref so rev-parse resolves locally (offline).
    repo.git(&["update-ref", "refs/remotes/origin/main", &head]);

    let preview = preview_delete_remote_branch(repo.path(), "origin", "main").expect("preview");
    assert!(preview.summary.contains("main"));
    assert!(preview.summary.contains("origin"));
    assert!(preview.warnings.iter().any(|line| line.contains("recover")));
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
fn empty_after_resolution_matches_only_the_empty_phrase() {
    // git's actual empty-patch message — must match.
    assert!(is_empty_after_resolution(
        "The previous cherry-pick is now empty, possibly due to conflict resolution."
    ));
    assert!(is_empty_after_resolution(
        "The previous revert is now empty."
    ));
    // Unrelated --continue failures must NOT be mistaken for "empty" (which
    // would silently --skip a patch the user wanted to keep).
    assert!(!is_empty_after_resolution(
        "error: Committing is not possible because you have unmerged files."
    ));
    assert!(!is_empty_after_resolution(
        "nothing to commit, working tree clean"
    ));
    assert!(!is_empty_after_resolution("hook rejected the commit"));
}

#[test]
fn worktree_path_rejects_escapes_and_accepts_relative() {
    let root = "/tmp/repo";
    assert!(worktree_path(root, "src/a.ts").is_ok());
    assert!(worktree_path(root, "nested/dir/file.txt").is_ok());
    assert!(worktree_path(root, "../escape.txt").is_err());
    assert!(worktree_path(root, "a/../../escape.txt").is_err());
    assert!(worktree_path(root, "/etc/passwd").is_err());
}

/// A repo with one commit on `main` and a configured (but offline) origin.
/// `git config` here keeps commits unsigned so CI without a signing key works.
fn repo_with_base_commit(tag: &str) -> (TempRepo, String) {
    let repo = TempRepo::new(tag);
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "base"]);
    repo.git(&["remote", "add", "origin", "https://example.test/r.git"]);
    let head = String::from_utf8(repo.git(&["rev-parse", "HEAD"]).stdout).unwrap();
    (repo, head.trim().to_string())
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

#[test]
fn publish_branch_validates_upstream_format_before_pushing() {
    let (repo, _) = repo_with_base_commit("publish-validate");
    // All of these fail format/operand validation before any network push, so
    // the offline origin is never contacted.
    assert!(
        publish_branch(
            repo.path(),
            "main",
            "originmain",
            &TransportCredential::None
        )
        .is_err(),
        "missing slash must be rejected"
    );
    assert!(
        publish_branch(repo.path(), "main", "/main", &TransportCredential::None).is_err(),
        "empty remote half must be rejected"
    );
    assert!(
        publish_branch(repo.path(), "main", "origin/", &TransportCredential::None).is_err(),
        "empty branch half must be rejected"
    );
    assert!(
        publish_branch(
            repo.path(),
            "--upload-pack=x",
            "origin/main",
            &TransportCredential::None
        )
        .is_err(),
        "option-like branch operand must be rejected"
    );
}

/// Build a modify/delete conflict: `base` committed, then HEAD modifies the
/// file while the merged branch deletes it. Returns the repo with the merge
/// stopped on the conflict (stage 2 = ours present, stage 3 = theirs absent).
fn modify_delete_repo(tag: &str) -> TempRepo {
    let repo = TempRepo::new(tag);
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "base"]);
    repo.git(&["checkout", "-q", "-b", "other"]);
    repo.git(&["rm", "-q", "f.txt"]);
    repo.git(&["commit", "-qm", "delete"]);
    repo.git(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("f.txt"), b"ours-modified\n").unwrap();
    repo.git(&["commit", "-qam", "modify"]);
    // Merge stops on the modify/delete conflict.
    let _ = repo.git(&["merge", "other"]);
    repo
}

#[test]
fn conflict_stage_absent_reflects_the_deleted_side() {
    let repo = modify_delete_repo("stage-absent");
    // Ours (stage 2) is present (we modified); theirs (stage 3) is absent
    // (they deleted). The guard must report exactly that, so a checkout
    // failure on the *present* side never falls through to `git rm`.
    assert!(
        !conflict_stage_absent(repo.path(), "f.txt", "2"),
        "ours stage should be present"
    );
    assert!(
        conflict_stage_absent(repo.path(), "f.txt", "3"),
        "theirs stage should be absent"
    );
}

#[test]
fn accept_conflict_side_keeps_modified_side() {
    let repo = modify_delete_repo("keep-ours");
    // Accept ours: the modified version is checked out and staged, file kept.
    let result = accept_conflict_side(repo.path(), "f.txt", "ours");
    assert!(result.is_ok(), "accept ours failed: {result:?}");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("f.txt")).unwrap(),
        "ours-modified\n"
    );
    // No unmerged entries remain for the file.
    let unmerged = repo.git(&["ls-files", "-u", "--", "f.txt"]);
    assert!(String::from_utf8_lossy(&unmerged.stdout).trim().is_empty());
}

#[test]
fn accept_conflict_side_takes_deletion_when_stage_absent() {
    let repo = modify_delete_repo("take-theirs");
    // Accept theirs (the deletion): checkout --theirs fails because stage 3
    // is absent, and ONLY then do we fall back to `git rm`.
    let result = accept_conflict_side(repo.path(), "f.txt", "theirs");
    assert!(result.is_ok(), "accept theirs failed: {result:?}");
    assert!(!repo.0.join("f.txt").exists(), "file should be removed");
}

#[test]
fn resolution_commands_reject_non_conflicted_paths() {
    // A normal committed file is a perfectly safe relative path, but it is
    // NOT in the conflict set — the resolution commands must refuse it so a
    // renderer can only act on genuinely-conflicted files.
    let repo = TempRepo::new("not-conflicted");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("clean.txt"), b"hi\n").unwrap();
    repo.git(&["add", "clean.txt"]);
    repo.git(&["commit", "-qm", "init"]);

    assert!(accept_conflict_side(repo.path(), "clean.txt", "ours").is_err());
    assert!(resolve_conflict_file(repo.path(), "clean.txt", "x\n").is_err());
    assert!(mark_conflict_resolved(repo.path(), "clean.txt").is_err());
    // The clean file must be untouched by the rejected write.
    assert_eq!(
        std::fs::read_to_string(repo.0.join("clean.txt")).unwrap(),
        "hi\n"
    );
}

/// Build a content conflict: `base` committed, then `other` and `main` change
/// the same line. Returns the repo with the merge stopped on the conflict.
fn merge_conflict_repo(tag: &str) -> TempRepo {
    let repo = TempRepo::new(tag);
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"line1\nbase\nline3\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "base"]);
    repo.git(&["checkout", "-q", "-b", "other"]);
    std::fs::write(repo.0.join("f.txt"), b"line1\ntheirs\nline3\n").unwrap();
    repo.git(&["commit", "-qam", "theirs"]);
    repo.git(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("f.txt"), b"line1\nours\nline3\n").unwrap();
    repo.git(&["commit", "-qam", "ours"]);
    // Merge stops on the content conflict in f.txt.
    let _ = repo.git(&["merge", "other"]);
    repo
}

#[test]
fn continue_operation_completes_a_resolved_merge() {
    let repo = merge_conflict_repo("continue");
    // Resolve + stage via the in-app write path, then continue.
    resolve_conflict_file(repo.path(), "f.txt", "line1\nmerged\nline3\n").unwrap();
    let result = continue_operation(repo.path(), "merge", Some("T"), Some("t@t.t"));
    assert!(result.is_ok(), "continue failed: {result:?}");
    // No conflicts remain and HEAD is a merge commit (two parents).
    let unmerged = repo.git(&["ls-files", "-u"]);
    assert!(String::from_utf8_lossy(&unmerged.stdout).trim().is_empty());
    let parents = repo.git(&["rev-list", "--parents", "-n", "1", "HEAD"]);
    let line = String::from_utf8_lossy(&parents.stdout);
    // "<commit> <parent1> <parent2>" → 3 hashes for a merge commit.
    assert_eq!(
        line.split_whitespace().count(),
        3,
        "expected a merge commit: {line:?}"
    );
}

#[test]
fn abort_operation_restores_pre_merge_state() {
    let repo = merge_conflict_repo("abort");
    let result = abort_operation(repo.path(), "merge");
    assert!(result.is_ok(), "abort failed: {result:?}");
    // Worktree returns to our pre-merge content and the tree is clean.
    assert_eq!(
        std::fs::read_to_string(repo.0.join("f.txt")).unwrap(),
        "line1\nours\nline3\n"
    );
    let status = repo.git(&["status", "--porcelain"]);
    assert!(String::from_utf8_lossy(&status.stdout).trim().is_empty());
}

#[test]
fn skip_operation_rejects_merge() {
    // Merge has no `--skip`; only sequencer ops do. The path is never touched.
    assert!(skip_operation("/tmp", "merge").is_err());
    assert!(skip_operation("/tmp", "nonsense").is_err());
}

#[test]
fn reconflict_file_restores_markers_after_staging() {
    let repo = merge_conflict_repo("reconflict");
    // Stage a resolution — the path is now merged (stage 0), not unmerged.
    resolve_conflict_file(repo.path(), "f.txt", "line1\nmerged\nline3\n").unwrap();
    let staged = repo.git(&["ls-files", "-u", "--", "f.txt"]);
    assert!(String::from_utf8_lossy(&staged.stdout).trim().is_empty());
    // Unstage: `git checkout --merge` recreates the conflict even after add.
    let result = reconflict_file(repo.path(), "f.txt");
    assert!(result.is_ok(), "reconflict failed: {result:?}");
    let unmerged = repo.git(&["ls-files", "-u", "--", "f.txt"]);
    assert!(!String::from_utf8_lossy(&unmerged.stdout).trim().is_empty());
    let body = std::fs::read_to_string(repo.0.join("f.txt")).unwrap();
    assert!(body.contains("<<<<<<<") && body.contains(">>>>>>>"));
}

#[test]
fn reconflict_file_rejected_outside_an_operation() {
    // With no merge/rebase/etc. underway there is no conflict to recreate;
    // `git checkout --merge` would just overwrite the worktree file with the
    // index copy, so the guard must refuse rather than risk clobbering edits.
    let repo = TempRepo::new("reconflict-clean");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"hi\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "init"]);
    let result = reconflict_file(repo.path(), "f.txt");
    assert!(
        result.is_err(),
        "expected refusal outside an operation: {result:?}"
    );
}

#[test]
fn resolves_a_dash_prefixed_conflicted_path() {
    // A tracked file named `-foo` can legitimately conflict. Every per-file
    // command passes the path after `--`, so it must resolve rather than be
    // rejected by the option-injection dash-guard.
    let repo = TempRepo::new("dash-conflict");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("-foo"), b"base\n").unwrap();
    repo.git(&["add", "--", "-foo"]);
    repo.git(&["commit", "-qm", "base"]);
    repo.git(&["checkout", "-q", "-b", "other"]);
    std::fs::write(repo.0.join("-foo"), b"theirs\n").unwrap();
    repo.git(&["commit", "-qam", "theirs"]);
    repo.git(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("-foo"), b"ours\n").unwrap();
    repo.git(&["commit", "-qam", "ours"]);
    let _ = repo.git(&["merge", "other"]);
    let result = resolve_conflict_file(repo.path(), "-foo", "merged\n");
    assert!(
        result.is_ok(),
        "dash-prefixed path should resolve: {result:?}"
    );
    let unmerged = repo.git(&["ls-files", "-u", "--", "-foo"]);
    assert!(String::from_utf8_lossy(&unmerged.stdout).trim().is_empty());
}

#[test]
fn reconflict_file_refuses_unrelated_path_and_keeps_edits() {
    // Mid-merge, re-conflicting a tracked file that was never part of the
    // conflict (no resolve-undo) must be refused — otherwise `checkout
    // --merge` would overwrite its unstaged edits with the index copy.
    let repo = TempRepo::new("reconflict-unrelated");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
    std::fs::write(repo.0.join("other.txt"), b"orig\n").unwrap();
    repo.git(&["add", "f.txt", "other.txt"]);
    repo.git(&["commit", "-qm", "base"]);
    repo.git(&["checkout", "-q", "-b", "other"]);
    std::fs::write(repo.0.join("f.txt"), b"theirs\n").unwrap();
    repo.git(&["commit", "-qam", "theirs"]);
    repo.git(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("f.txt"), b"ours\n").unwrap();
    repo.git(&["commit", "-qam", "ours"]);
    let _ = repo.git(&["merge", "other"]); // conflicts on f.txt only
                                           // Unstaged edit to the unrelated, non-conflicted file.
    std::fs::write(repo.0.join("other.txt"), b"my precious edits\n").unwrap();
    let result = reconflict_file(repo.path(), "other.txt");
    assert!(
        result.is_err(),
        "should refuse a non-conflict path: {result:?}"
    );
    // The edit survives — checkout --merge never ran.
    assert_eq!(
        std::fs::read_to_string(repo.0.join("other.txt")).unwrap(),
        "my precious edits\n"
    );
}

fn remote_url(repo: &TempRepo, args: &[&str]) -> String {
    let out = repo.git(args);
    assert!(out.status.success(), "git {args:?} failed");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
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
fn merge_pins_no_ff_against_merge_ff_config() {
    let repo = TempRepo::new("merge-no-ff");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);

    // Base commit on main.
    std::fs::write(repo.0.join("file.txt"), b"base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["branch", "-M", "main"]);

    // A feature branch with one extra commit (so a plain merge *could* fast-forward).
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("file.txt"), b"feature\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "feature work"]);

    // `merge.ff=only` would refuse a real merge commit — the flag must override it.
    repo.git_ok(&["config", "merge.ff", "only"]);
    repo.git_ok(&["checkout", "-q", "main"]);

    let out = merge(repo.path(), "feature").expect("merge succeeds despite merge.ff=only");
    // Guard the store's toast mapping: a merge that really created a commit
    // must never carry the up-to-date phrase (`src/lib/mergeOutcome.ts`).
    assert!(
        !out.contains("Already up to date"),
        "a real merge must not report up-to-date: {out}"
    );

    // HEAD is a merge commit: `rev-list --parents -1` lists the commit plus its
    // two parents (three whitespace-separated hashes). A fast-forward would have
    // left a single-parent commit (two hashes).
    let out = repo.git(&["rev-list", "--parents", "-1", "HEAD"]);
    assert!(out.status.success(), "rev-list failed");
    let line = String::from_utf8_lossy(&out.stdout);
    let hashes = line.split_whitespace().count();
    assert_eq!(
        hashes, 3,
        "expected a merge commit (commit + 2 parents), got {hashes} hashes: {line:?}"
    );
}

#[test]
fn merge_of_an_already_reachable_branch_reports_up_to_date_and_creates_nothing() {
    let repo = TempRepo::new("merge-up-to-date");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("file.txt"), b"base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["branch", "-M", "main"]);
    repo.git_ok(&["branch", "feature"]);

    let head = |repo: &TempRepo| {
        let out = repo.git(&["rev-parse", "HEAD"]);
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };

    // Equal tips (the menu offers Merge here since GL-113): `--no-ff` does NOT
    // force a merge commit — git exits 0 with "Already up to date." and creates
    // nothing. The store keys its toast off that output, and the subprocess is
    // pinned to LC_ALL=C so the phrase is stable under a localized git.
    let before = head(&repo);
    let out = merge(repo.path(), "feature").expect("merge of an equal tip succeeds");
    assert!(
        out.contains("Already up to date"),
        "equal tips must report up-to-date: {out}"
    );
    assert_eq!(
        head(&repo),
        before,
        "no commit may be created for equal tips"
    );

    // Already-merged ancestor: same no-op once main moves ahead of feature.
    std::fs::write(repo.0.join("file.txt"), b"ahead\n").unwrap();
    repo.git_ok(&["commit", "-q", "-am", "ahead"]);
    let before = head(&repo);
    let out = merge(repo.path(), "feature").expect("merge of an ancestor succeeds");
    assert!(
        out.contains("Already up to date"),
        "an ancestor must report up-to-date: {out}"
    );
    assert_eq!(
        head(&repo),
        before,
        "no commit may be created for an ancestor"
    );
}

#[test]
fn fast_forward_is_a_no_op_on_equal_tips() {
    let repo = TempRepo::new("ff-equal-tips");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("file.txt"), b"base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["branch", "-M", "main"]);
    repo.git_ok(&["branch", "feature"]);

    let head_out = repo.git(&["rev-parse", "HEAD"]);
    let head = String::from_utf8_lossy(&head_out.stdout).trim().to_string();

    // The probe now reports equal tips as fast-forwardable (GL-113), so both
    // write paths the menu can dispatch to must treat them as an up-to-date
    // no-op rather than fail: `merge --ff-only` on the checked-out branch and
    // `fetch . <target>:<branch>` on a branch that isn't checked out.
    fast_forward(repo.path(), "feature").expect("ff-only merge of an equal tip succeeds");
    fast_forward_branch(repo.path(), "feature", "main")
        .expect("in-place ff of an equal tip succeeds");

    // Nothing moved: both refs still point at the original commit.
    for rev in ["HEAD", "refs/heads/feature"] {
        let out = repo.git(&["rev-parse", rev]);
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            head,
            "{rev} must be unchanged by a no-op fast-forward"
        );
    }
}

#[test]
fn fast_forward_branch_no_op_when_equal_tip_branch_is_checked_out_in_worktree() {
    let repo = TempRepo::new("ff-equal-linked-worktree");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("file.txt"), b"base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["branch", "-M", "main"]);
    repo.git_ok(&["branch", "feature"]);
    let linked = repo.0.with_file_name(format!(
        "gitlane-ff-equal-linked-worktree-linked-{}",
        std::process::id()
    ));
    let linked_str = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", linked_str, "feature"]);

    let head = rev_parse(&repo, "main");

    let out = fast_forward_branch(repo.path(), "feature", "main")
        .expect("equal-tip branch held by another worktree is already current");

    assert!(out.contains("Already up to date"));
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), head);
    let _ = std::fs::remove_dir_all(linked);
}

/// Shared fixture for the pull tests: a seed repo with one commit on `main`
/// and a local clone of it. Returned as (root, seed, clone) — `root` owns the
/// parent temp dir, the other two wrap its subdirectories (their Drop is a
/// no-op after root's cleanup, which `remove_dir_all` tolerates).
fn seed_and_clone(tag: &str) -> (TempRepo, TempRepo, TempRepo) {
    let root = TempRepo::new(tag);
    let seed_dir = root.0.join("seed");
    let clone_dir = root.0.join("clone");

    let init = Command::new("git")
        .args(["init", "-q", seed_dir.to_str().unwrap()])
        .output()
        .expect("git init launches");
    assert!(
        init.status.success(),
        "init failed\nstderr:\n{}",
        String::from_utf8_lossy(&init.stderr)
    );
    let seed = TempRepo(seed_dir);
    seed.git_ok(&["config", "user.name", "GitLane Test"]);
    seed.git_ok(&["config", "user.email", "gitlane@example.test"]);
    seed.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(seed.0.join("file.txt"), b"v1\n").unwrap();
    seed.git_ok(&["add", "file.txt"]);
    seed.git_ok(&["commit", "-q", "-m", "seed"]);
    seed.git_ok(&["branch", "-M", "main"]);

    let clone_out = Command::new("git")
        .args(["clone", "-q", seed.path(), clone_dir.to_str().unwrap()])
        .output()
        .expect("git clone launches");
    assert!(
        clone_out.status.success(),
        "clone failed\nstderr:\n{}",
        String::from_utf8_lossy(&clone_out.stderr)
    );
    (root, seed, TempRepo(clone_dir))
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

/// A repo with one commit of `f.txt`, ready for stash churn (GL-117 tests).
fn stash_seed_repo(tag: &str) -> TempRepo {
    let repo = TempRepo::new(tag);
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "base"]);
    repo
}

#[test]
fn stash_includes_staged_unstaged_and_untracked_changes() {
    let repo = stash_seed_repo("stash-all-changes");

    std::fs::write(repo.0.join("staged.txt"), b"staged\n").unwrap();
    repo.git_ok(&["add", "staged.txt"]);
    std::fs::write(repo.0.join("f.txt"), b"unstaged\n").unwrap();
    std::fs::write(repo.0.join("untracked.txt"), b"untracked\n").unwrap();

    stash(repo.path()).expect("stash all visible changes");

    let status = repo.git(&["status", "--porcelain"]);
    assert!(
        String::from_utf8_lossy(&status.stdout).trim().is_empty(),
        "stash should leave no visible changes"
    );

    let oid = stash_list(repo.path()).expect("list")[0].oid.clone();
    stash_apply(repo.path(), &oid).expect("restore all visible changes");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("staged.txt")).unwrap(),
        "staged\n"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("f.txt")).unwrap(),
        "unstaged\n"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("untracked.txt")).unwrap(),
        "untracked\n"
    );
}

#[test]
fn stash_apply_by_oid_survives_index_churn() {
    // Apply (unlike pop) leaves the stash on the stack; addressing by oid must
    // still resolve the originally-picked stash after out-of-band churn.
    let repo = stash_seed_repo("stash-oid-apply");

    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["stash", "push", "-qm", "one"]);
    let picked = stash_list(repo.path()).expect("list")[0].oid.clone();

    // Out-of-band churn: "one" moves from stash@{0} to stash@{1}.
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["stash", "push", "-qm", "two"]);

    stash_apply(repo.path(), &picked).expect("apply the picked stash by oid");

    let content = std::fs::read_to_string(repo.0.join("f.txt")).unwrap();
    assert_eq!(
        content, "one\n",
        "the picked stash was applied, not stash@{{0}}"
    );
    assert_eq!(
        stash_list(repo.path()).expect("list after apply").len(),
        2,
        "apply must leave both stashes on the stack"
    );
}

#[test]
fn stash_pop_by_oid_survives_index_churn() {
    // GL-117: the user picks a stash from a list snapshot, then another stash
    // lands out-of-band (terminal, sibling worktree) and shifts every
    // `stash@{n}`. Popping by oid must still hit the picked stash.
    let repo = stash_seed_repo("stash-oid-pop");

    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["stash", "push", "-qm", "one"]);
    let picked = stash_list(repo.path()).expect("list")[0].oid.clone();

    // Out-of-band churn: "one" moves from stash@{0} to stash@{1}.
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["stash", "push", "-qm", "two"]);

    stash_pop(repo.path(), &picked).expect("pop the picked stash by oid");

    let content = std::fs::read_to_string(repo.0.join("f.txt")).unwrap();
    assert_eq!(
        content, "one\n",
        "the picked stash was applied, not stash@{{0}}"
    );
    let remaining = stash_list(repo.path()).expect("list after pop");
    assert_eq!(remaining.len(), 1, "only the picked stash was dropped");
    assert_eq!(remaining[0].message, "On main: two");
}

#[test]
fn stash_drop_by_oid_survives_index_churn_and_refuses_when_gone() {
    let repo = stash_seed_repo("stash-oid-drop");

    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["stash", "push", "-qm", "one"]);
    let picked = stash_list(repo.path()).expect("list")[0].oid.clone();
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["stash", "push", "-qm", "two"]);

    stash_drop(repo.path(), &picked).expect("drop the picked stash by oid");
    let remaining = stash_list(repo.path()).expect("list after drop");
    assert_eq!(remaining.len(), 1);
    assert_eq!(
        remaining[0].message, "On main: two",
        "the newer stash survived"
    );

    // Dropping again: the stash is gone, so the destructive op must refuse
    // rather than fall back to any index.
    let err = stash_drop(repo.path(), &picked).expect_err("second drop refuses");
    assert!(
        err.contains("no longer exists"),
        "error should say the stash is gone: {err}"
    );
}

#[test]
fn stash_branch_by_oid_still_drops_the_stash() {
    // `git stash branch <name> <oid>` would apply but silently SKIP the drop —
    // only a `stash@{n}` reference keeps the drop semantics, so the op resolves
    // the oid to its current index first.
    let repo = stash_seed_repo("stash-oid-branch");

    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["stash", "push", "-qm", "one"]);
    let picked = stash_list(repo.path()).expect("list")[0].oid.clone();

    stash_branch(repo.path(), "from-stash", &picked).expect("stash branch by oid");

    let head = repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]);
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "from-stash");
    let content = std::fs::read_to_string(repo.0.join("f.txt")).unwrap();
    assert_eq!(content, "one\n", "the stash was applied on the new branch");
    assert!(
        stash_list(repo.path())
            .expect("list after branch")
            .is_empty(),
        "stash branch must drop the consumed stash"
    );
}

/// Index entries (`git ls-files`) as owned lines, for asserting what is staged.
fn index_entries(repo: &TempRepo) -> Vec<String> {
    let out = repo.git(&["ls-files"]);
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_string)
        .collect()
}

#[test]
fn unstage_works_on_an_unborn_repo() {
    // GL-115 Bug 1: with no commits yet, `restore --staged` and `reset HEAD`
    // die with "could not resolve 'HEAD'" — the very first stage → unstage in
    // a fresh `git init` repo must still work, via the index-only fallbacks.
    let repo = TempRepo::new("unborn-unstage");
    repo.git_ok(&["init", "-q"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    std::fs::write(repo.0.join("b.txt"), "b\n").unwrap();
    stage_files(repo.path(), &["a.txt".into(), "b.txt".into()]).expect("stage on unborn HEAD");

    unstage_file(repo.path(), "a.txt").expect("unstage one file on unborn HEAD");
    assert_eq!(
        index_entries(&repo),
        ["b.txt"],
        "only a.txt leaves the index"
    );
    assert!(
        repo.0.join("a.txt").exists(),
        "unstage must not touch the worktree copy"
    );

    // Re-stage, then edit the worktree copy so index ≠ worktree — the unborn
    // fallback (`rm --cached`) must still unstage without tripping git's
    // staged-content safety check.
    stage_file(repo.path(), "a.txt").expect("re-stage a.txt");
    std::fs::write(repo.0.join("a.txt"), "a edited\n").unwrap();
    unstage_files(repo.path(), &["a.txt".into(), "b.txt".into()])
        .expect("unstage several files on unborn HEAD");
    assert!(
        index_entries(&repo).is_empty(),
        "index is empty after unstaging both"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
        "a edited\n",
        "worktree edit survives unstaging"
    );

    stage_files(repo.path(), &["a.txt".into(), "b.txt".into()]).expect("stage again");
    unstage_all(repo.path()).expect("unstage all on unborn HEAD");
    assert!(
        index_entries(&repo).is_empty(),
        "index is empty after unstage-all"
    );
    assert!(repo.0.join("a.txt").exists() && repo.0.join("b.txt").exists());
}

#[test]
fn discard_removes_a_staged_new_file_despite_a_stale_staged_flag() {
    // GL-115 Bug 2: `git clean` only removes *untracked* files, so discard with
    // staged=false used to exit 0 and silently leave a staged-new file in both
    // index and worktree. The index — not the caller's flag — decides.
    let repo = TempRepo::new("discard-staged-new");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&[
        "commit",
        "-q",
        "--no-gpg-sign",
        "--allow-empty",
        "-m",
        "root",
    ]);

    std::fs::write(repo.0.join("staged_new.txt"), "new\n").unwrap();
    repo.git_ok(&["add", "staged_new.txt"]);
    std::fs::write(repo.0.join("untracked.txt"), "loose\n").unwrap();

    discard_file(repo.path(), "staged_new.txt", false).expect("discard staged-new file");
    assert!(
        index_entries(&repo).is_empty(),
        "staged-new file leaves the index"
    );
    assert!(
        !repo.0.join("staged_new.txt").exists(),
        "staged-new file leaves the worktree"
    );

    // The genuinely untracked path still goes through `git clean`.
    discard_file(repo.path(), "untracked.txt", false).expect("discard untracked file");
    assert!(
        !repo.0.join("untracked.txt").exists(),
        "untracked file is cleaned"
    );
}

#[test]
fn discard_file_preserves_empty_directory_shells() {
    let repo = repo_with_file("discard-file-empty-dirs", "tracked.txt", b"base\n");
    std::fs::create_dir_all(repo.0.join("untracked/empty-nested")).unwrap();
    std::fs::write(repo.0.join("untracked/file.txt"), "new\n").unwrap();

    discard_file(repo.path(), "untracked/file.txt", false).expect("discard untracked file");

    assert!(!repo.0.join("untracked/file.txt").exists());
    assert!(repo.0.join("untracked/empty-nested").is_dir());
}

#[test]
fn discard_removes_a_staged_new_file_with_staged_true_on_a_born_repo() {
    // GL-115 Bug 2 regression: the new `git rm -f` path must behave like the
    // old restore-then-clean flow for the staged=true case on a repo that does
    // have history — clearing the staged-new file from index and worktree.
    let repo = TempRepo::new("discard-staged-true-born");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&[
        "commit",
        "-q",
        "--no-gpg-sign",
        "--allow-empty",
        "-m",
        "root",
    ]);

    std::fs::write(repo.0.join("staged_new.txt"), "new\n").unwrap();
    repo.git_ok(&["add", "staged_new.txt"]);

    discard_file(repo.path(), "staged_new.txt", true).expect("discard staged=true new file");
    assert!(
        index_entries(&repo).is_empty(),
        "staged-new file leaves the index"
    );
    assert!(
        !repo.0.join("staged_new.txt").exists(),
        "staged-new file leaves the worktree"
    );
}

#[test]
fn discard_staged_file_works_on_an_unborn_repo() {
    // GL-115 Bug 1 interplay: discard(staged=true) used to open with
    // `restore --staged`, which dies on an unborn HEAD. The `git rm -f` path
    // needs no HEAD at all.
    let repo = TempRepo::new("unborn-discard");
    repo.git_ok(&["init", "-q"]);
    std::fs::write(repo.0.join("new.txt"), "new\n").unwrap();
    stage_file(repo.path(), "new.txt").expect("stage on unborn HEAD");

    discard_file(repo.path(), "new.txt", true).expect("discard staged file on unborn HEAD");
    assert!(index_entries(&repo).is_empty(), "file leaves the index");
    assert!(!repo.0.join("new.txt").exists(), "file leaves the worktree");
}

#[test]
fn merge_disambiguates_a_branch_from_a_same_named_tag() {
    // Git's rev resolution gives a tag precedence over a same-named branch, so a
    // bare `git merge feature` would merge the TAG. GitLane qualifies to
    // refs/heads/ in that ambiguous case so the branch is merged instead.
    let repo = TempRepo::new("merge-ambiguous");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "user.email", "t@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "base"]);
    let base = rev_parse(&repo, "HEAD");

    // Branch `feature` one commit ahead; tag `feature` pinned at the base.
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "branch-work"]);
    let branch_tip = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "main"]);
    repo.git_ok(&["tag", "feature", &base]);

    merge(repo.path(), "feature").expect("merge the branch, not the tag");

    // A real merge commit whose second parent is the branch tip — not the tag
    // (which, being the base, would have produced "Already up to date").
    assert_eq!(
        rev_parse(&repo, "HEAD^2"),
        branch_tip,
        "merge must target the branch, not the same-named tag"
    );
}

#[test]
fn merge_keeps_the_bare_name_when_no_tag_clashes() {
    // Without a clashing tag the bare name is used unchanged, so the merge
    // message keeps its clean "Merge branch 'feature'" form.
    let repo = TempRepo::new("merge-unambiguous");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "user.email", "t@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "base"]);
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "branch-work"]);
    repo.git_ok(&["checkout", "-q", "main"]);

    merge(repo.path(), "feature").expect("merge succeeds");

    let subject = String::from_utf8_lossy(&repo.git(&["log", "-1", "--format=%s"]).stdout)
        .trim()
        .to_string();
    assert_eq!(subject, "Merge branch 'feature'");
}

#[test]
fn reset_targets_a_branch_over_a_same_named_tag() {
    // `git reset --hard feature` resolves the TAG first when both exist; the
    // write path qualifies to refs/heads/ so reset lands on the branch tip.
    let repo = TempRepo::new("reset-ambiguous");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "user.email", "t@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "base"]);
    let base = rev_parse(&repo, "HEAD");

    // Branch `feature` one commit ahead of the tag `feature` (pinned at base).
    repo.git_ok(&["branch", "feature"]);
    repo.git_ok(&["tag", "feature", &base]);
    repo.git_ok(&["checkout", "-q", "feature"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "branch-work"]);
    let branch_tip = rev_parse(&repo, "HEAD");
    // Back on main, and move it forward so the reset is a real move.
    repo.git_ok(&["checkout", "-q", "main"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "main-work"]);

    reset(repo.path(), "feature", "hard").expect("reset to the branch, not the tag");

    assert_eq!(
        rev_parse(&repo, "HEAD"),
        branch_tip,
        "reset must land on the branch tip, not the same-named tag at base"
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

    // A local-tracking branch (`.`) is not a network remote; push auth falls
    // back to origin instead of looking for a remote literally named ".".
    repo.git_ok(&["config", "branch.main.remote", "."]);
    assert_eq!(branch_push_remote(repo.path(), "main"), "origin");
    assert_eq!(head_push_remote(repo.path()), "origin");
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
fn remote_credential_host_for_prefers_the_push_url_host() {
    let repo = TempRepo::new("remote-host-for");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&[
        "remote",
        "add",
        "origin",
        "https://github.com/owner/repo.git",
    ]);
    assert_eq!(
        crate::git::forge::remote_credential_host_for(repo.path(), "origin").as_deref(),
        Some("github.com")
    );

    // A separate push URL drives pushes, so it drives auth validation too.
    repo.git_ok(&[
        "remote",
        "set-url",
        "--push",
        "origin",
        "git@bitbucket.org:team/repo.git",
    ]);
    assert_eq!(
        crate::git::forge::remote_credential_host_for(repo.path(), "origin").as_deref(),
        Some("bitbucket.org")
    );

    assert_eq!(
        crate::git::forge::remote_credential_host_for(repo.path(), "missing"),
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

/// Path compare that survives macOS `/var` → `/private/var` canonicalization.
fn same_path(a: &str, b: &str) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a.trim_end_matches('/') == b.trim_end_matches('/'),
    }
}

#[test]
fn init_in_place_initializes_a_non_empty_existing_directory() {
    let dir = TempRepo::new("init-in-place");
    std::fs::write(dir.0.join("existing.txt"), b"already here\n").unwrap();

    let result = init_in_place(dir.path()).expect("init_in_place should succeed");

    assert!(same_path(&result, dir.path()));
    assert!(dir.0.join(".git").is_dir());
    // The pre-existing file must survive — this is the whole point of the
    // in-place action over the empty-dir-only `init`.
    assert!(dir.0.join("existing.txt").exists());
}

#[test]
fn init_in_place_rejects_an_already_initialized_directory() {
    let dir = TempRepo::new("init-in-place-existing-repo");
    dir.git_ok(&["init", "-q"]);

    let err = init_in_place(dir.path()).expect_err("already a repo must be rejected");
    assert!(err.contains("already a Git repository"), "{err}");
    assert!(err.contains("try Retry"), "{err}");
}

#[test]
fn init_in_place_repairs_a_broken_or_partial_git_directory() {
    // A stray/interrupted `.git` (e.g. a crashed `git init`, or a folder a
    // backup tool created) satisfies a raw "does .git exist" check but isn't
    // a repo libgit2 can open — exactly the state that produces the
    // `notARepository` classification driving this recovery action. It must
    // not dead-end here (GL-153 review): `git init` repairs it in place.
    let dir = TempRepo::new("init-in-place-broken-git");
    std::fs::create_dir_all(dir.0.join(".git")).unwrap();
    std::fs::write(dir.0.join("existing.txt"), b"already here\n").unwrap();

    let result = init_in_place(dir.path()).expect("a broken .git must be repairable");

    assert!(same_path(&result, dir.path()));
    assert!(dir.0.join(".git/HEAD").is_file(), "init must have run for real");
    assert!(dir.0.join("existing.txt").exists());
}

#[test]
fn init_in_place_repairs_a_dangling_git_worktree_pointer_file() {
    // A `.git` *file* (a linked worktree's gitdir pointer) left behind after
    // its parent repo/worktree entry is gone: `rev-parse` correctly rejects
    // it, but plain `git init` also refuses to run over a `.git` file at all
    // (unlike the directory case above) — this must not dead-end either.
    let dir = TempRepo::new("init-in-place-dangling-worktree-file");
    std::fs::write(dir.0.join(".git"), b"gitdir: /nonexistent/path/to/gitdir\n").unwrap();
    std::fs::write(dir.0.join("existing.txt"), b"already here\n").unwrap();

    let result = init_in_place(dir.path()).expect("a dangling .git file must be repairable");

    assert!(same_path(&result, dir.path()));
    assert!(dir.0.join(".git").is_dir(), "the stale .git file must be replaced with a real gitdir");
    assert!(dir.0.join("existing.txt").exists());
}

#[test]
fn init_in_place_rejects_a_nonexistent_path() {
    let dir = TempRepo::new("init-in-place-missing");
    let gone = dir.0.join("does-not-exist");

    let err =
        init_in_place(gone.to_str().unwrap()).expect_err("a nonexistent path must be rejected");
    assert!(err.contains("not a folder"), "{err}");
}

#[test]
fn init_in_place_rejects_dash_prefixed_paths() {
    let err = init_in_place("-D").expect_err("a dash-prefixed path must be rejected");
    assert!(err.contains("Refusing unsafe git argument"), "{err}");
}

#[test]
fn init_in_place_initializes_the_exact_directory_without_trimming_whitespace() {
    // The path comes from repo state and must be treated as opaque — trimming
    // would point `git init` at a different sibling if both exist.
    let base = std::env::temp_dir().join(format!("gitlane-init-ws-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let dir_with_space = base.join("repo ");
    std::fs::create_dir_all(&dir_with_space).unwrap();
    let trimmed_sibling = base.join("repo");
    std::fs::create_dir_all(&trimmed_sibling).unwrap();
    std::fs::write(trimmed_sibling.join("wrong.txt"), b"wrong\n").unwrap();

    let path = dir_with_space.to_string_lossy().to_string();
    let result = init_in_place(&path).expect("init must target the exact path");

    assert!(same_path(&result, &path));
    assert!(dir_with_space.join(".git").is_dir(), "the spaced directory must be initialized");
    assert!(
        !trimmed_sibling.join(".git").exists(),
        "the trimmed sibling must not be touched"
    );
    assert!(trimmed_sibling.join("wrong.txt").exists());

    let _ = std::fs::remove_dir_all(&base);
}

/// A minimal committed repo with one text file, for the file-editor writes.
fn repo_with_file(tag: &str, name: &str, contents: &[u8]) -> TempRepo {
    let repo = TempRepo::new(tag);
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join(name), contents).unwrap();
    repo.git_ok(&["add", name]);
    repo.git_ok(&["commit", "-q", "-m", "seed"]);
    repo
}

#[test]
fn write_repo_file_overwrites_and_reports_new_size() {
    let repo = repo_with_file("wrf-ok", "a.txt", b"old\n");
    let size = write_repo_file(repo.path(), "a.txt", "new content\n", Some(4)).expect("write ok");
    assert_eq!(size, "new content\n".len() as u64);
    assert_eq!(std::fs::read_to_string(repo.0.join("a.txt")).unwrap(), "new content\n");
}

#[test]
fn write_repo_file_rejects_size_mismatch() {
    let repo = repo_with_file("wrf-size", "a.txt", b"old\n");
    // On-disk is 4 bytes; a caller that loaded a different size (or a truncated
    // >2 MiB prefix) must be refused before the unseen remainder is destroyed.
    let err = write_repo_file(repo.path(), "a.txt", "x", Some(999)).unwrap_err();
    assert!(err.contains("changed on disk"), "unexpected: {err}");
    assert_eq!(std::fs::read_to_string(repo.0.join("a.txt")).unwrap(), "old\n");
}

#[test]
fn write_repo_file_refuses_new_file() {
    let repo = repo_with_file("wrf-new", "a.txt", b"old\n");
    // Overwrite-only: the panel never lists a nonexistent path.
    assert!(write_repo_file(repo.path(), "nope.txt", "x", None).is_err());
    assert!(!repo.0.join("nope.txt").exists());
}

#[test]
fn write_repo_file_refuses_binary_content_and_binary_target() {
    let repo = repo_with_file("wrf-bin", "a.txt", b"old\n");
    // NUL in the incoming content — scanned in full, not just the sniff window.
    assert!(write_repo_file(repo.path(), "a.txt", "a\0b", Some(4)).is_err());
    let late_nul = format!("{}\0", "x".repeat(9000));
    assert!(write_repo_file(repo.path(), "a.txt", &late_nul, Some(4)).is_err());
    assert_eq!(std::fs::read_to_string(repo.0.join("a.txt")).unwrap(), "old\n");

    // NUL already on disk — an editor should never have offered it as text.
    let bin = repo_with_file("wrf-bin2", "b.bin", b"\0\0\0\0");
    let err = write_repo_file(bin.path(), "b.bin", "text", Some(4)).unwrap_err();
    assert!(err.contains("binary"), "unexpected: {err}");
}

#[test]
fn write_repo_file_refuses_oversized_and_dotgit_paths() {
    let repo = repo_with_file("wrf-cap", "a.txt", b"old\n");
    // A file larger than the read cap could only have been read as a prefix.
    let big = repo.0.join("big.txt");
    std::fs::write(&big, vec![b'x'; 2 * 1024 * 1024 + 1]).unwrap();
    let err = write_repo_file(repo.path(), "big.txt", "x", None).unwrap_err();
    assert!(err.contains("too large"), "unexpected: {err}");

    // Incoming content is capped too — a small file can't be grown past the cap.
    let huge = "x".repeat(2 * 1024 * 1024 + 1);
    let err = write_repo_file(repo.path(), "a.txt", &huge, Some(4)).unwrap_err();
    assert!(err.contains("too large"), "unexpected: {err}");
    assert_eq!(std::fs::read_to_string(repo.0.join("a.txt")).unwrap(), "old\n");

    // The raw IPC surface must not be pointed at repository metadata.
    assert!(write_repo_file(repo.path(), ".git/config", "x", None).is_err());
    assert!(write_repo_file(repo.path(), ".GIT/config", "x", None).is_err());
}

#[test]
fn write_repo_file_leaves_original_intact_and_preserves_mode() {
    let repo = repo_with_file("wrf-atomic", "a.sh", b"#!/bin/sh\necho hi\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(repo.0.join("a.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let before = std::fs::metadata(repo.0.join("a.sh")).unwrap().permissions().mode() & 0o777;
        write_repo_file(repo.path(), "a.sh", "#!/bin/sh\necho bye\n", Some(18)).expect("write ok");
        let after = std::fs::metadata(repo.0.join("a.sh")).unwrap().permissions().mode() & 0o777;
        assert_eq!(before, after, "executable bit must survive the atomic replace");
    }
    assert_eq!(std::fs::read_to_string(repo.0.join("a.sh")).unwrap(), "#!/bin/sh\necho bye\n");
    // No temp files should be left behind in the worktree.
    let leftovers: Vec<_> = std::fs::read_dir(&repo.0)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains("gitlane-tmp"))
        .collect();
    assert!(leftovers.is_empty(), "atomic write left a temp file behind");
}

#[test]
fn write_repo_file_rejects_traversal_and_symlink() {
    let repo = repo_with_file("wrf-guard", "a.txt", b"old\n");
    assert!(write_repo_file(repo.path(), "../escape.txt", "x", None).is_err());
    assert!(write_repo_file(repo.path(), "/etc/hosts", "x", None).is_err());

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("a.txt", repo.0.join("link.txt")).unwrap();
        // A symlink is not a regular file — refuse rather than follow it.
        assert!(write_repo_file(repo.path(), "link.txt", "x", None).is_err());
    }
}
