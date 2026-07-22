use super::branch_checkout::align_equivalent_sibling;
use super::conflict_resolution::{conflict_stage_absent, is_empty_after_resolution};
use super::lifecycle::init_in_place;
use super::operands::ensure_operand;
use super::patch_staging::{apply_hunk_patch, patch_diff_args};
use super::remotes::{
    is_concurrent_fetch_ref_update, is_missing_remote_ref, is_tag_clobber_rejection,
    push_endpoint_token, push_target_at,
};
use super::worktrees::is_porcelain_record;
use super::{
    abort_operation, accept_conflict_side, add_remote, apply_hunk, apply_line, branch_pull_target,
    branch_push_remote, checkout, checkout_remote_branch, cherry_pick, cherry_pick_many,
    cherry_pick_many_onto, cherry_pick_onto, clear_repo_identity, commit_expected,
    continue_operation, create_annotated_tag, create_branch, create_branch_in_worktree,
    create_patch, create_tag, delete_branch, delete_branch_with_worktree, delete_remote_branch,
    delete_remote_tag, delete_tag, discard_all, discard_file, fast_forward, fast_forward_branch,
    fast_forward_branch_at, fetch, force_push, head_push_remote, mark_conflict_resolved, merge,
    merge_into, move_branch_to_worktree, preview_delete_branch, preview_delete_remote_branch,
    preview_discard_all, preview_discard_file, preview_force_push, preview_remove_worktree,
    preview_reset, publish_branch, publish_remote, pull, pull_branch, push_branch, rebase,
    reconflict_file, reflog_entries, remove_worktree, reset_branch, resolve_conflict_file, revert,
    revert_many, revert_onto, set_before_replace_test_hook,
    set_discard_all_after_cleanup_test_hook, set_discard_all_after_first_clean_batch_test_hook,
    set_discard_all_after_tracked_scope_validation_test_hook,
    set_discard_all_after_validation_test_hook, set_discard_all_before_tracked_reset_test_hook,
    set_discard_all_capture_test_hook, set_discard_capture_test_hook,
    set_hard_reset_after_fingerprint_test_hook, set_hard_reset_after_validation_test_hook,
    set_hard_reset_before_mutation_test_hook, set_hard_reset_capture_test_hook, set_remote_url,
    set_remote_username, set_repo_identity, set_squash_after_commit_test_hook, set_upstream,
    skip_operation, squash_commits, stage_file, stage_files,
    start_discard_all_fingerprint_byte_count, stash, stash_apply, stash_apply_index_onto,
    stash_apply_onto, stash_branch, stash_drop, stash_expected, stash_list, stash_pop,
    stash_pop_onto, take_discard_all_fingerprint_byte_count, unstage_all, unstage_file,
    unstage_files, worktree_dirty_state, worktree_is_dirty, worktrees, write_repo_file,
};
use crate::git::read::repo_identity;
use crate::git::transport_auth::{
    credential_for_remote, ProviderTokenBridge, RemoteTransportDirection, TransportCredential,
};
use crate::git::types::{ForcePushRouteLease, GitTransportAuthRef};
use crate::git::worktree_fs::set_after_guarded_rename_test_hook;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

const CLEAN_PATH_BATCH_MAX_ARGS: usize = 500;

fn discard_all_previewed(repo: &str) -> Result<String, String> {
    let preview = preview_discard_all(repo)?;
    discard_all(
        repo,
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
}

fn remove_worktree_previewed(repo: &str, worktree_path: &str) -> Result<String, String> {
    let preview = preview_remove_worktree(repo, worktree_path)?;
    remove_worktree(repo, worktree_path, &preview.expected_state)
}

fn delete_branch_with_worktree_previewed(
    repo: &str,
    branch: &str,
    from_worktree_path: &str,
    expected_oid: &str,
    progress: &dyn Fn(&'static str),
) -> Result<String, String> {
    let preview = preview_remove_worktree(repo, from_worktree_path)?;
    delete_branch_with_worktree(
        repo,
        branch,
        from_worktree_path,
        expected_oid,
        &preview.expected_state,
        progress,
    )
}

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

#[test]
fn checkout_branch_intent_never_falls_back_to_restoring_a_same_named_path() {
    let repo = repo_with_file("checkout-intent", "stale-branch", b"original\n");
    std::fs::write(repo.0.join("stale-branch"), b"precious edit\n").unwrap();

    assert!(checkout(repo.path(), "stale-branch", false).is_err());
    assert_eq!(
        std::fs::read_to_string(repo.0.join("stale-branch")).unwrap(),
        "precious edit\n"
    );

    let head = rev_parse(&repo, "HEAD");
    checkout(repo.path(), &head, true).expect("explicit detached checkout");
    assert!(repo.git(&["branch", "--show-current"]).stdout.is_empty());
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

#[test]
fn rebase_uses_explicit_source_instead_of_previously_active_branch() {
    let repo = TempRepo::new("rebase-explicit-source");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
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
    let main_tip = rev_parse(&repo, "main");

    repo.git_ok(&["checkout", "-q", "-b", "previously-active"]);
    std::fs::write(repo.0.join("active.txt"), "active\n").unwrap();
    repo.git_ok(&["add", "active.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "previously active work"]);
    let active_tip = rev_parse(&repo, "previously-active");

    let feature_tip = rev_parse(&repo, "feature");
    rebase(repo.path(), "feature", &feature_tip, &main_tip)
        .expect("rebase explicit source onto main");

    let head = repo.git(&["branch", "--show-current"]);
    assert!(head.status.success());
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "feature");
    assert_eq!(rev_parse(&repo, "feature^"), main_tip);
    assert_eq!(rev_parse(&repo, "previously-active"), active_tip);
    let active_is_feature_ancestor = repo.git(&[
        "merge-base",
        "--is-ancestor",
        "previously-active",
        "feature",
    ]);
    assert!(
        !active_is_feature_ancestor.status.success(),
        "the previously active branch must not become the rebase target"
    );
}

#[test]
fn rebase_keeps_detached_head_support_with_an_explicit_source() {
    let repo = TempRepo::new("rebase-detached-source");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);

    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    let base = rev_parse(&repo, "HEAD");

    repo.git_ok(&["checkout", "-q", "--detach", &base]);
    std::fs::write(repo.0.join("detached.txt"), "detached\n").unwrap();
    repo.git_ok(&["add", "detached.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "detached work"]);
    let detached_tip = rev_parse(&repo, "HEAD");

    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("main.txt"), "main\n").unwrap();
    repo.git_ok(&["add", "main.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "main work"]);
    let main_tip = rev_parse(&repo, "main");
    repo.git_ok(&["checkout", "-q", "--detach", &detached_tip]);

    rebase(repo.path(), "HEAD", &detached_tip, &main_tip).expect("rebase detached HEAD onto main");

    let head = repo.git(&["branch", "--show-current"]);
    assert!(head.status.success());
    assert!(head.stdout.is_empty(), "HEAD should remain detached");
    assert_eq!(rev_parse(&repo, "HEAD^"), main_tip);
    let message = repo.git(&["log", "-1", "--format=%s"]);
    assert!(message.status.success());
    assert_eq!(
        String::from_utf8_lossy(&message.stdout).trim(),
        "detached work"
    );
}

#[test]
fn rebase_explicit_source_prefers_a_local_branch_over_same_named_tag() {
    let repo = TempRepo::new("rebase-ambiguous-source");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);

    std::fs::write(repo.0.join("base.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "base.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["tag", "feature"]);
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("feature.txt"), "feature\n").unwrap();
    repo.git_ok(&["add", "feature.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "feature work"]);

    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("main.txt"), "main\n").unwrap();
    repo.git_ok(&["add", "main.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "main work"]);
    let main_tip = rev_parse(&repo, "main");

    let feature_tip = rev_parse(&repo, "refs/heads/feature");
    rebase(repo.path(), "feature", &feature_tip, &main_tip)
        .expect("rebase the branch, not its tag");

    let head = repo.git(&["branch", "--show-current"]);
    assert!(head.status.success());
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "feature");
    assert_eq!(rev_parse(&repo, "refs/heads/feature^"), main_tip);
}

#[test]
fn merge_into_uses_explicit_destination_instead_of_active_branch() {
    let (repo, base) = repo_with_base_commit("merge-explicit-destination");
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("feature.txt"), "feature\n").unwrap();
    repo.git_ok(&["add", "feature.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "feature"]);
    let feature_tip = rev_parse(&repo, "feature");

    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("main.txt"), "main\n").unwrap();
    repo.git_ok(&["add", "main.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "main"]);
    let main_tip = rev_parse(&repo, "main");

    repo.git_ok(&["checkout", "-q", "-b", "previously-active", &base]);
    std::fs::write(repo.0.join("active.txt"), "active\n").unwrap();
    repo.git_ok(&["add", "active.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "active"]);
    let active_tip = rev_parse(&repo, "previously-active");

    merge_into(
        repo.path(),
        "refs/heads/feature",
        &feature_tip,
        Some("main"),
        &main_tip,
    )
    .expect("merge explicit source into explicit destination");

    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout).trim(),
        "main"
    );
    assert!(repo
        .git(&["merge-base", "--is-ancestor", "feature", "main"])
        .status
        .success());
    assert_eq!(rev_parse(&repo, "previously-active"), active_tip);
    // The validated qualified ref must not leak into the generated subject.
    let subject = repo.git(&["log", "-1", "--format=%s", "main"]);
    assert!(subject.status.success());
    assert!(
        String::from_utf8_lossy(&subject.stdout).starts_with("Merge branch 'feature'"),
        "unexpected merge subject: {}",
        String::from_utf8_lossy(&subject.stdout)
    );
}

#[test]
fn merge_into_names_a_remote_tracking_source_by_its_short_name() {
    let (repo, base) = repo_with_base_commit("merge-remote-source-subject");
    repo.git_ok(&["checkout", "-q", "-b", "topic"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "topic work"]);
    let topic_tip = rev_parse(&repo, "topic");
    repo.git_ok(&["update-ref", "refs/remotes/origin/topic", &topic_tip]);
    repo.git_ok(&["checkout", "-q", "main"]);
    repo.git_ok(&["branch", "-D", "topic"]);

    merge_into(
        repo.path(),
        "refs/remotes/origin/topic",
        &topic_tip,
        Some("main"),
        &base,
    )
    .expect("merge remote-tracking source");

    let subject = repo.git(&["log", "-1", "--format=%s", "main"]);
    assert!(subject.status.success());
    assert!(
        String::from_utf8_lossy(&subject.stdout)
            .starts_with("Merge remote-tracking branch 'origin/topic'"),
        "unexpected merge subject: {}",
        String::from_utf8_lossy(&subject.stdout)
    );
}

#[test]
fn merge_into_keeps_the_qualified_source_when_a_tag_shadows_the_branch() {
    let (repo, base) = repo_with_base_commit("merge-tag-shadowed-source");
    // A tag named `feature` at a *different* commit shadows the branch for
    // bare-name resolution, so the merge must keep the qualified operand.
    repo.git_ok(&["tag", "feature", &base]);
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "feature work"]);
    let feature_tip = rev_parse(&repo, "refs/heads/feature");
    repo.git_ok(&["checkout", "-q", "main"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "main work"]);
    let main_tip = rev_parse(&repo, "main");

    merge_into(
        repo.path(),
        "refs/heads/feature",
        &feature_tip,
        Some("main"),
        &main_tip,
    )
    .expect("merge the shadowed branch");

    // The branch commit — not the tag's — is what got merged.
    assert_eq!(rev_parse(&repo, "main^2"), feature_tip);
}

#[test]
fn merge_into_rejects_a_stale_destination_before_checkout() {
    let (repo, base) = repo_with_base_commit("merge-stale-destination");
    repo.git_ok(&["branch", "feature"]);
    repo.git_ok(&["checkout", "-q", "-b", "previously-active"]);
    let active_tip = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "main"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "main moved"]);
    let moved_main = rev_parse(&repo, "main");
    repo.git_ok(&["checkout", "-q", "previously-active"]);

    let result = merge_into(repo.path(), "feature", &base, Some("main"), &base);
    assert!(result.is_err(), "stale destination must fail closed");
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout).trim(),
        "previously-active"
    );
    assert_eq!(rev_parse(&repo, "previously-active"), active_tip);
    assert_eq!(rev_parse(&repo, "main"), moved_main);
}

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
fn fast_forward_and_reset_mutate_only_the_explicit_branch() {
    let (repo, base) = repo_with_base_commit("explicit-fast-forward-reset");
    repo.git_ok(&["branch", "moving"]);
    repo.git_ok(&["checkout", "-q", "-b", "target"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "target"]);
    let target_tip = rev_parse(&repo, "target");
    repo.git_ok(&["checkout", "-q", "-b", "previously-active", &base]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "active"]);
    let active_tip = rev_parse(&repo, "previously-active");

    fast_forward_branch_at(repo.path(), "moving", &base, &target_tip)
        .expect("fast-forward explicit branch");
    assert_eq!(rev_parse(&repo, "moving"), target_tip);
    assert_eq!(rev_parse(&repo, "previously-active"), active_tip);
    assert!(
        fast_forward_branch_at(repo.path(), "moving", &base, &target_tip).is_err(),
        "a stale expected tip must not overwrite the moved branch"
    );

    // Hard-reset lease is of the worktree being reset: check out `moving`
    // before preview so tip preparation does not change the leased state.
    repo.git_ok(&["checkout", "-q", "moving"]);
    let preview = preview_reset(repo.path(), &base, "hard", "moving").expect("hard-reset preview");
    reset_branch(
        repo.path(),
        Some("moving"),
        Some(&target_tip),
        &base,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect("reset explicit branch");
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout).trim(),
        "moving"
    );
    assert_eq!(rev_parse(&repo, "moving"), base);
    assert_eq!(rev_parse(&repo, "previously-active"), active_tip);
}

#[test]
fn fast_forward_updates_a_linked_worktree_instead_of_only_its_ref() {
    let (repo, base) = repo_with_base_commit("fast-forward-linked-worktree");
    repo.git_ok(&["branch", "moving"]);
    repo.git_ok(&["checkout", "-q", "-b", "target"]);
    std::fs::write(repo.0.join("target.txt"), "target\n").unwrap();
    repo.git_ok(&["add", "target.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "target"]);
    let target_tip = rev_parse(&repo, "target");
    repo.git_ok(&["checkout", "-q", "main"]);

    let linked = TempRepo::new("fast-forward-linked-owner");
    repo.git_ok(&["worktree", "add", "-q", linked.path(), "moving"]);

    fast_forward_branch_at(repo.path(), "moving", &base, &target_tip)
        .expect("fast-forward in owning worktree");

    assert_eq!(rev_parse(&repo, "moving"), target_tip);
    assert_eq!(rev_parse(&linked, "HEAD"), target_tip);
    assert!(linked.0.join("target.txt").is_file());
    assert!(
        linked.git(&["status", "--porcelain"]).stdout.is_empty(),
        "the owning worktree must stay clean after its branch advances"
    );
}

#[test]
fn fast_forward_refuses_dirty_changes_in_the_owning_worktree() {
    let (repo, base) = repo_with_base_commit("fast-forward-dirty-linked-worktree");
    repo.git_ok(&["branch", "moving"]);
    repo.git_ok(&["checkout", "-q", "-b", "target"]);
    std::fs::write(repo.0.join("f.txt"), "target\n").unwrap();
    repo.git_ok(&["commit", "-q", "-a", "-m", "target"]);
    let target_tip = rev_parse(&repo, "target");
    repo.git_ok(&["checkout", "-q", "main"]);

    let linked = TempRepo::new("fast-forward-dirty-linked-owner");
    repo.git_ok(&["worktree", "add", "-q", linked.path(), "moving"]);
    std::fs::write(linked.0.join("f.txt"), "dirty\n").unwrap();

    fast_forward_branch_at(repo.path(), "moving", &base, &target_tip)
        .expect_err("dirty owning worktree must block fast-forward");

    assert_eq!(rev_parse(&repo, "moving"), base);
    assert_eq!(rev_parse(&linked, "HEAD"), base);
    assert_eq!(
        std::fs::read_to_string(linked.0.join("f.txt")).unwrap(),
        "dirty\n"
    );
    assert_eq!(
        String::from_utf8_lossy(&linked.git(&["status", "--porcelain"]).stdout).trim_end(),
        " M f.txt"
    );
}

#[test]
fn merge_into_preserves_detached_head_support() {
    let (repo, base) = repo_with_base_commit("merge-detached-destination");
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "feature"]);
    let feature_tip = rev_parse(&repo, "feature");
    repo.git_ok(&["checkout", "-q", "--detach", &base]);

    merge_into(repo.path(), "feature", &feature_tip, None, &base)
        .expect("merge into detached HEAD");

    assert!(repo.git(&["branch", "--show-current"]).stdout.is_empty());
    assert!(repo
        .git(&["merge-base", "--is-ancestor", "feature", "HEAD"])
        .status
        .success());
}

#[test]
fn head_guarded_writes_reject_a_different_active_branch() {
    let (repo, base) = repo_with_base_commit("guarded-head-writes");
    repo.git_ok(&["checkout", "-q", "-b", "pick-source"]);
    std::fs::write(repo.0.join("picked.txt"), "picked\n").unwrap();
    repo.git_ok(&["add", "picked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "picked"]);
    let picked = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "main"]);
    repo.git_ok(&["checkout", "-q", "-b", "unexpected"]);
    let unexpected_tip = rev_parse(&repo, "HEAD");
    std::fs::write(repo.0.join("staged.txt"), "staged\n").unwrap();
    repo.git_ok(&["add", "staged.txt"]);

    assert!(cherry_pick_onto(repo.path(), Some("main"), &base, &picked).is_err());
    assert!(revert_onto(repo.path(), Some("main"), &base, &picked).is_err());
    assert!(commit_expected(
        repo.path(),
        Some("main"),
        Some(&base),
        "must not commit",
        "",
        false,
        None,
        None,
        None,
        false,
    )
    .is_err());
    assert_eq!(rev_parse(&repo, "unexpected"), unexpected_tip);
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout).trim(),
        "unexpected"
    );
}

#[test]
fn head_guarded_stash_writes_reject_a_different_active_branch() {
    let (repo, base) = repo_with_base_commit("guarded-stash-writes");
    std::fs::write(repo.0.join("stashed.txt"), "stashed\n").unwrap();
    repo.git_ok(&["add", "stashed.txt"]);
    stash_expected(repo.path(), Some("main"), Some(&base)).expect("create guarded stash");
    let stash_oid = rev_parse(&repo, "stash@{0}");
    repo.git_ok(&["checkout", "-q", "-b", "unexpected"]);

    for result in [
        stash_apply_onto(repo.path(), Some("main"), Some(&base), &stash_oid),
        stash_apply_index_onto(repo.path(), Some("main"), Some(&base), &stash_oid),
        stash_pop_onto(repo.path(), Some("main"), Some(&base), &stash_oid),
    ] {
        let error = result.expect_err("wrong active branch must fail closed");
        assert!(error.contains("HEAD changed"), "unexpected error: {error}");
    }
    assert!(!repo.0.join("stashed.txt").exists());
    assert_eq!(rev_parse(&repo, "stash@{0}"), stash_oid);
}

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

fn tip_range_for_squash(tag: &str) -> (TempRepo, String, String) {
    let (repo, base) = repo_with_base_commit(tag);
    std::fs::write(repo.0.join("f.txt"), "one\n").unwrap();
    repo.git_ok(&["commit", "-q", "-a", "-m", "one"]);
    std::fs::write(repo.0.join("f.txt"), "two\n").unwrap();
    repo.git_ok(&["commit", "-q", "-a", "-m", "two"]);
    let tip = rev_parse(&repo, "HEAD");
    (repo, base, tip)
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

    assert!(
        error.contains("feature is checked out"),
        "unexpected: {error}"
    );
    assert!(
        error.contains("couldn't be fast-forwarded"),
        "unexpected: {error}"
    );
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

    // A config edited outside GitLane can contain duplicate values. Applying a
    // card must collapse them so later reads/clears remain deterministic.
    repo.git_ok(&["config", "--local", "--add", "user.name", "Old One"]);
    repo.git_ok(&["config", "--local", "--add", "user.name", "Old Two"]);
    repo.git_ok(&[
        "config",
        "--local",
        "--add",
        "user.email",
        "old@example.test",
    ]);

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
    let names = repo.git(&["config", "--local", "--get-all", "user.name"]);
    assert!(names.status.success(), "updated name should be readable");
    assert_eq!(
        String::from_utf8_lossy(&names.stdout)
            .lines()
            .collect::<Vec<_>>(),
        ["Work Dev"]
    );

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

    // Duplicate values previously made `git config --unset` exit 5 while
    // leaving the config untouched. `--unset-all` must clear every value.
    repo.git_ok(&["config", "--local", "--add", "user.name", "Duplicate"]);
    repo.git_ok(&["config", "--local", "--add", "user.signingkey", "KEY2"]);

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
fn clear_repo_identity_accepts_absent_keys_but_surfaces_real_git_errors() {
    let repo = TempRepo::new("identity-clear-absent");
    repo.git_ok(&["init", "-q"]);
    clear_repo_identity(repo.path()).expect("already-absent identity is cleared");

    let not_a_repo = TempRepo::new("identity-clear-not-repo");
    let error = clear_repo_identity(not_a_repo.path()).expect_err("invalid repo must fail");
    assert!(!error.is_empty(), "real git failure should be surfaced");
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
    super::commit(
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

    let error = super::commit(
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
    let error = super::commit(
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
    let expected = rev_parse(&repo, "refs/tags/v1");

    let remote = TempRepo::new("delete-remote-tag-origin");
    remote.git_ok(&["init", "-q", "--bare"]);
    repo.git_ok(&["remote", "add", "origin", remote.path()]);
    repo.git_ok(&["push", "-q", "origin", "refs/tags/v1", "refs/heads/v1"]);

    delete_remote_tag(
        repo.path(),
        "origin",
        "v1",
        &expected,
        &TransportCredential::None,
    )
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
fn delete_tag_refuses_to_remove_a_tag_moved_after_confirmation() {
    let repo = repo_with_file("delete-local-tag-lease", "a.txt", b"one\n");
    repo.git_ok(&["tag", "--no-sign", "v1"]);
    let expected = rev_parse(&repo, "refs/tags/v1");

    std::fs::write(repo.0.join("a.txt"), b"two\n").unwrap();
    repo.git_ok(&["add", "a.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "second"]);
    repo.git_ok(&["tag", "--no-sign", "-f", "v1"]);
    let moved = rev_parse(&repo, "refs/tags/v1");
    assert_ne!(expected, moved);

    let error = delete_tag(repo.path(), "v1", &expected)
        .expect_err("stale confirmation must not delete the moved tag");
    assert!(
        error.contains("cannot lock ref") || error.contains("is at"),
        "unexpected update-ref diagnostic: {error}"
    );
    assert_eq!(rev_parse(&repo, "refs/tags/v1"), moved);

    delete_tag(repo.path(), "v1", &moved).expect("current tag target can be deleted");
    assert!(
        !repo
            .git(&["show-ref", "--verify", "refs/tags/v1"])
            .status
            .success(),
        "tag should be absent after an exact-target delete"
    );
}

#[test]
fn delete_remote_tag_refuses_to_remove_a_tag_moved_after_confirmation() {
    let repo = repo_with_file("delete-remote-tag-lease", "a.txt", b"one\n");
    repo.git_ok(&["tag", "--no-sign", "v1"]);
    let expected = rev_parse(&repo, "refs/tags/v1");
    let remote = TempRepo::new("delete-remote-tag-lease-origin");
    remote.git_ok(&["init", "-q", "--bare"]);
    repo.git_ok(&["remote", "add", "origin", remote.path()]);
    repo.git_ok(&["push", "-q", "origin", "refs/tags/v1"]);

    std::fs::write(repo.0.join("a.txt"), b"two\n").unwrap();
    repo.git_ok(&["add", "a.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "second"]);
    repo.git_ok(&["tag", "--no-sign", "-f", "v1"]);
    let moved = rev_parse(&repo, "refs/tags/v1");
    repo.git_ok(&["push", "-q", "--force", "origin", "refs/tags/v1"]);

    delete_remote_tag(
        repo.path(),
        "origin",
        "v1",
        &expected,
        &TransportCredential::None,
    )
    .expect_err("stale confirmation must not delete the moved remote tag");

    assert_eq!(rev_parse(&remote, "refs/tags/v1"), moved);
}

#[test]
fn delete_remote_tag_checks_absence_on_the_push_endpoint() {
    let repo = repo_with_file("delete-remote-tag-pushurl", "a.txt", b"one\n");
    repo.git_ok(&["tag", "--no-sign", "v1"]);
    let expected = rev_parse(&repo, "refs/tags/v1");

    let fetch_remote = TempRepo::new("delete-remote-tag-fetch-url");
    fetch_remote.git_ok(&["init", "-q", "--bare"]);
    let push_remote = TempRepo::new("delete-remote-tag-push-url");
    push_remote.git_ok(&["init", "-q", "--bare"]);
    repo.git_ok(&["remote", "add", "origin", fetch_remote.path()]);
    repo.git_ok(&["remote", "set-url", "--push", "origin", push_remote.path()]);
    repo.git_ok(&["push", "-q", "origin", "refs/tags/v1"]);

    std::fs::write(repo.0.join("a.txt"), b"two\n").unwrap();
    repo.git_ok(&["add", "a.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "second"]);
    repo.git_ok(&["tag", "--no-sign", "-f", "v1"]);
    let moved = rev_parse(&repo, "refs/tags/v1");
    repo.git_ok(&["push", "-q", "--force", "origin", "refs/tags/v1"]);

    delete_remote_tag(
        repo.path(),
        "origin",
        "v1",
        &expected,
        &TransportCredential::None,
    )
    .expect_err("an absent fetch URL must not hide a stale tag on the push URL");

    assert_eq!(rev_parse(&push_remote, "refs/tags/v1"), moved);
}

#[test]
fn delete_remote_branch_is_qualified_and_pinned_to_the_seen_tip() {
    let repo = repo_with_file("delete-remote-branch", "a.txt", b"one\n");
    repo.git_ok(&["branch", "v1"]);
    repo.git_ok(&["tag", "v1"]);
    let expected = rev_parse(&repo, "refs/heads/v1");
    let remote = TempRepo::new("delete-remote-branch-origin");
    remote.git_ok(&["init", "-q", "--bare"]);
    repo.git_ok(&["remote", "add", "origin", remote.path()]);
    repo.git_ok(&["push", "-q", "origin", "refs/heads/v1", "refs/tags/v1"]);

    // Hostile inherited push config must not widen or replace this operation.
    repo.git_ok(&["config", "push.followTags", "true"]);
    repo.git_ok(&["config", "remote.origin.mirror", "true"]);
    delete_remote_branch(
        repo.path(),
        "origin",
        "v1",
        &expected,
        &TransportCredential::None,
    )
    .expect("delete the exact branch");

    assert!(!remote
        .git(&["show-ref", "--verify", "refs/heads/v1"])
        .status
        .success());
    assert!(remote
        .git(&["show-ref", "--verify", "refs/tags/v1"])
        .status
        .success());

    // Recreate the branch at a newer commit. A delete authorized for the old
    // snapshot must be rejected and preserve the remotely advanced ref.
    repo.git_ok(&[
        "commit",
        "-q",
        "--allow-empty",
        "--no-gpg-sign",
        "-m",
        "advance",
    ]);
    let advanced = rev_parse(&repo, "HEAD");
    repo.git_ok(&[
        "-c",
        "remote.origin.mirror=false",
        "push",
        "-q",
        "origin",
        "HEAD:refs/heads/v1",
    ]);
    assert!(delete_remote_branch(
        repo.path(),
        "origin",
        "v1",
        &expected,
        &TransportCredential::None,
    )
    .is_err());
    assert_eq!(rev_parse(&remote, "refs/heads/v1"), advanced);
}

#[test]
fn create_patch_refuses_merges_and_never_overwrites_an_existing_file() {
    let repo = repo_with_file("create-patch-safe", "base.txt", b"base\n");
    repo.git_ok(&["checkout", "-q", "-b", "side"]);
    std::fs::write(repo.0.join("side.txt"), b"side\n").unwrap();
    repo.git_ok(&["add", "side.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "side"]);
    repo.git_ok(&["checkout", "-q", "main"]);
    repo.git_ok(&[
        "commit",
        "-q",
        "--allow-empty",
        "--no-gpg-sign",
        "-m",
        "main",
    ]);
    repo.git_ok(&[
        "merge",
        "-q",
        "--no-ff",
        "--no-gpg-sign",
        "-m",
        "merge",
        "side",
    ]);
    let merge = rev_parse(&repo, "HEAD");
    assert!(create_patch(repo.path(), &merge).is_err());
    assert!(!repo.0.join("0001-side.patch").exists());

    let side = rev_parse(&repo, "side");
    std::fs::write(repo.0.join("0001-side.patch"), b"keep me\n").unwrap();
    let created = create_patch(repo.path(), &side).expect("create collision-safe patch");
    assert_eq!(created, "0001-side-2.patch");
    assert_eq!(
        std::fs::read(repo.0.join("0001-side.patch")).unwrap(),
        b"keep me\n"
    );
    let patch = std::fs::read(repo.0.join(created)).unwrap();
    assert!(patch.starts_with(b"From "));
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
    let expected = rev_parse(&repo, "refs/tags/v9");

    let remote = TempRepo::new("delete-remote-tag-unpushed-origin");
    remote.git_ok(&["init", "-q", "--bare"]);
    repo.git_ok(&["remote", "add", "origin", remote.path()]);

    // "Delete everywhere" on a local-only tag: absence upstream is the desired
    // end state, so this must not fail (the combined delete then proceeds to
    // the local half). How git reports it varies by transport — file remotes
    // exit 0 with a "deleting a non-existent ref" warning, smart-HTTP servers
    // reject with "remote ref does not exist" (mapped to Ok by the tolerance
    // tested below) — so assert the behavior, not the message.
    delete_remote_tag(
        repo.path(),
        "origin",
        "v9",
        &expected,
        &TransportCredential::None,
    )
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
fn discard_all_preview_rejects_an_unborn_repository() {
    let repo = TempRepo::new("discard-unborn");
    repo.git_ok(&["init", "-q"]);
    std::fs::write(repo.0.join("staged.txt"), b"hello").unwrap();
    repo.git_ok(&["add", "staged.txt"]);

    let error = preview_discard_all(repo.path())
        .expect_err("an unborn repository has no safe committed restore tree");

    assert!(error.contains("unavailable before the first commit"));
    assert!(repo.0.join("staged.txt").exists());
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["ls-files", "--cached"]).stdout).trim(),
        "staged.txt"
    );
}

#[test]
fn discard_all_rejects_worktree_drift_before_mutating() {
    let repo = repo_with_file("discard-stale", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("tracked.txt"), "previewed edit\n").unwrap();
    std::fs::write(repo.0.join("approved.txt"), "approved\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview");

    std::fs::write(repo.0.join("new-after-preview.txt"), "new\n").unwrap();
    let error = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("new worktree state must stale the lease");

    assert!(error.contains("changed after this confirmation"));
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "previewed edit\n"
    );
    assert!(repo.0.join("approved.txt").exists());
    assert!(repo.0.join("new-after-preview.txt").exists());
}

#[test]
fn discard_all_keeps_untracked_files_created_after_final_validation() {
    let repo = repo_with_file("discard-late-untracked", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("tracked.txt"), "changed\n").unwrap();
    std::fs::write(repo.0.join("approved.txt"), "approved\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview");
    let late = repo.0.join("late.txt");
    let late_for_hook = late.clone();
    set_discard_all_after_validation_test_hook(move || {
        std::fs::write(late_for_hook, "late\n").unwrap();
    });

    discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect("discard approved state");

    assert!(!repo.0.join("approved.txt").exists());
    assert_eq!(std::fs::read_to_string(late).unwrap(), "late\n");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "base\n"
    );
}

#[test]
fn discard_all_normalizes_an_approved_untracked_copy_at_a_staged_delete() {
    let repo = repo_with_file("discard-delete-recreated", "victim.txt", b"base\n");
    repo.git_ok(&["rm", "-q", "victim.txt"]);
    std::fs::write(repo.0.join("victim.txt"), "replacement\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview staged delete and replacement");

    discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect("clean replacement then restore tracked file");

    assert_eq!(
        std::fs::read_to_string(repo.0.join("victim.txt")).unwrap(),
        "base\n"
    );
    assert!(String::from_utf8_lossy(
        &repo
            .git(&["status", "--porcelain", "--untracked-files=all"])
            .stdout
    )
    .trim()
    .is_empty());
}

#[test]
fn discard_all_rejects_an_ignored_replacement_at_a_staged_delete() {
    let repo = repo_with_file(
        "discard-delete-ignored-replacement",
        "victim.txt",
        b"base\n",
    );
    std::fs::write(repo.0.join(".gitignore"), "victim.txt\n").unwrap();
    repo.git_ok(&["add", ".gitignore"]);
    repo.git_ok(&["commit", "-q", "-m", "ignore victim"]);
    repo.git_ok(&["rm", "-q", "victim.txt"]);
    std::fs::write(repo.0.join("victim.txt"), "precious ignored replacement\n").unwrap();

    let error = preview_discard_all(repo.path())
        .expect_err("an ignored replacement must not be silently reset");

    assert!(
        error.contains("staged for deletion") && error.contains("unapproved replacement"),
        "unexpected refusal: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("victim.txt")).unwrap(),
        "precious ignored replacement\n"
    );
}

#[cfg(unix)]
#[test]
fn discard_all_rejects_an_ignored_symlink_at_a_staged_delete() {
    use std::os::unix::fs::symlink;

    let repo = repo_with_file("discard-delete-ignored-symlink", "victim.txt", b"base\n");
    std::fs::write(repo.0.join(".gitignore"), "victim.txt\n").unwrap();
    repo.git_ok(&["add", ".gitignore"]);
    repo.git_ok(&["commit", "-q", "-m", "ignore victim"]);
    repo.git_ok(&["rm", "-q", "victim.txt"]);
    symlink("precious-target", repo.0.join("victim.txt")).unwrap();

    let error = preview_discard_all(repo.path())
        .expect_err("an ignored symlink must not be silently reset");

    assert!(error.contains("staged for deletion"));
    assert_eq!(
        std::fs::read_link(repo.0.join("victim.txt")).unwrap(),
        PathBuf::from("precious-target")
    );
}

#[test]
fn discard_all_confirmation_reuses_tracked_content_fingerprints() {
    let repo = repo_with_file("discard-reuse-fingerprints", "tracked.bin", b"base\n");
    let edited = vec![b'x'; 512 * 1024];
    std::fs::write(repo.0.join("tracked.bin"), &edited).unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview");

    start_discard_all_fingerprint_byte_count();
    discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect("discard previewed edit");
    let fingerprinted = take_discard_all_fingerprint_byte_count();

    assert_eq!(
        fingerprinted,
        4 * edited.len() as u64,
        "confirmation should hash two stable captures and two post-clean captures"
    );
}

#[test]
fn discard_all_reports_when_cleanup_ran_but_a_path_reappeared() {
    let repo = repo_with_file("discard-clean-reappeared", "tracked.txt", b"base\n");
    let approved = repo.0.join("approved.txt");
    std::fs::write(&approved, "approved\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview");
    let approved_for_hook = approved.clone();
    set_discard_all_after_first_clean_batch_test_hook(move || {
        std::fs::write(approved_for_hook, "precious late content\n").unwrap();
    });

    let error = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("a recreated path must stop the reset");

    assert!(
        error.contains("cleanup ran") && error.contains("did not remove"),
        "unexpected post-clean diagnostic: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(approved).unwrap(),
        "precious late content\n"
    );
}

#[test]
fn discard_all_preserves_a_staged_delete_path_recreated_after_cleanup() {
    let repo = repo_with_file("discard-delete-late-recreate", "victim.txt", b"base\n");
    repo.git_ok(&["rm", "-q", "victim.txt"]);
    std::fs::write(repo.0.join("victim.txt"), "approved replacement\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview");
    let victim = repo.0.join("victim.txt");
    let victim_for_hook = victim.clone();
    set_discard_all_after_cleanup_test_hook(move || {
        std::fs::write(victim_for_hook, "precious late replacement\n").unwrap();
    });

    let error = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("a recreated overlap must stop reset");

    assert!(error.contains("cleanup completed") && error.contains("recreated before reset"));
    assert_eq!(
        std::fs::read_to_string(victim).unwrap(),
        "precious late replacement\n"
    );
}

#[test]
fn discard_all_revalidates_each_cleanup_batch() {
    let repo = repo_with_file("discard-clean-batch-race", "tracked.txt", b"base\n");
    for index in 0..=CLEAN_PATH_BATCH_MAX_ARGS {
        std::fs::write(repo.0.join(format!("batch-{index:04}.txt")), "approved\n").unwrap();
    }
    let preview = preview_discard_all(repo.path()).expect("preview");
    let late_batch_path = repo
        .0
        .join(format!("batch-{CLEAN_PATH_BATCH_MAX_ARGS:04}.txt"));
    let late_for_hook = late_batch_path.clone();
    set_discard_all_after_first_clean_batch_test_hook(move || {
        std::fs::write(late_for_hook, "precious late content\n").unwrap();
    });

    let error = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("later cleanup batch must revalidate its files");

    assert!(error.contains("partially completed") && error.contains("changed before its cleanup"));
    assert!(!repo.0.join("batch-0000.txt").exists());
    assert_eq!(
        std::fs::read_to_string(late_batch_path).unwrap(),
        "precious late content\n"
    );
}

#[cfg(unix)]
#[test]
fn discard_all_reports_partial_cleanup_before_a_later_validation_error() {
    use std::os::unix::fs::symlink;

    let repo = repo_with_file("discard-clean-batch-io", "tracked.txt", b"base\n");
    for index in 0..CLEAN_PATH_BATCH_MAX_ARGS {
        std::fs::write(repo.0.join(format!("batch-{index:04}.txt")), "approved\n").unwrap();
    }
    let late_parent = repo.0.join("z-late");
    std::fs::create_dir(&late_parent).unwrap();
    std::fs::write(late_parent.join("target.txt"), "approved\n").unwrap();
    let outside = TempRepo::new("discard-clean-batch-io-outside");
    std::fs::write(outside.0.join("target.txt"), "precious outside\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview");
    let late_parent_for_hook = late_parent.clone();
    let outside_for_hook = outside.0.clone();
    set_discard_all_after_first_clean_batch_test_hook(move || {
        std::fs::remove_dir_all(&late_parent_for_hook).unwrap();
        symlink(outside_for_hook, late_parent_for_hook).unwrap();
    });

    let error = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("an unreadable later path must stop its cleanup batch");

    assert!(
        error.contains("partially completed")
            && error.contains("could not be rechecked before its cleanup batch"),
        "unexpected partial-clean diagnostic: {error}"
    );
    assert!(!repo.0.join("batch-0000.txt").exists());
    assert_eq!(
        std::fs::read_to_string(outside.0.join("target.txt")).unwrap(),
        "precious outside\n"
    );
}

#[test]
fn discard_all_works_in_a_linked_worktree_without_touching_its_main_checkout() {
    let main = repo_with_file("discard-linked-normal", "tracked.txt", b"base\n");
    main.git_ok(&["branch", "feature"]);
    let linked = TempRepo::new("discard-linked-normal-worktree");
    std::fs::remove_dir_all(&linked.0).unwrap();
    main.git_ok(&["worktree", "add", "-q", linked.path(), "feature"]);
    std::fs::write(linked.0.join("tracked.txt"), "linked edit\n").unwrap();
    std::fs::write(linked.0.join("untracked.txt"), "remove\n").unwrap();

    discard_all_previewed(linked.path()).expect("discard linked-worktree changes");

    assert_eq!(
        std::fs::read_to_string(linked.0.join("tracked.txt")).unwrap(),
        "base\n"
    );
    assert!(!linked.0.join("untracked.txt").exists());
    assert_eq!(
        std::fs::read_to_string(main.0.join("tracked.txt")).unwrap(),
        "base\n"
    );
    main.git_ok(&["worktree", "remove", "--force", linked.path()]);
}

#[test]
fn discard_all_rejects_a_linked_worktree_gitfile_retarget_before_reset() {
    let main = repo_with_file("discard-linked-gitfile", "tracked.txt", b"base\n");
    main.git_ok(&["branch", "feature"]);
    let linked = TempRepo::new("discard-linked-gitfile-worktree");
    std::fs::remove_dir_all(&linked.0).unwrap();
    main.git_ok(&["worktree", "add", "-q", linked.path(), "feature"]);
    let decoy = repo_with_file("discard-linked-gitfile-decoy", "tracked.txt", b"decoy\n");
    std::fs::write(linked.0.join("tracked.txt"), "approved linked edit\n").unwrap();
    let preview = preview_discard_all(linked.path()).expect("preview linked edit");
    let gitfile = linked.0.join(".git");
    let original_gitfile = std::fs::read(&gitfile).unwrap();
    let gitfile_for_hook = gitfile.clone();
    let decoy_gitdir = decoy.0.join(".git").canonicalize().unwrap();
    set_discard_all_before_tracked_reset_test_hook(move || {
        std::fs::write(
            gitfile_for_hook,
            format!("gitdir: {}\n", decoy_gitdir.display()),
        )
        .unwrap();
    });

    let result = discard_all(
        linked.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    );
    std::fs::write(&gitfile, original_gitfile).unwrap();
    let error = result.expect_err("retargeted gitfile must invalidate the captured scope");

    assert!(
        error.contains("working tree changed after this confirmation"),
        "unexpected scope error: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(linked.0.join("tracked.txt")).unwrap(),
        "approved linked edit\n"
    );
    assert_eq!(
        std::fs::read_to_string(decoy.0.join("tracked.txt")).unwrap(),
        "decoy\n"
    );
    main.git_ok(&["worktree", "remove", "--force", linked.path()]);
}

#[test]
fn discard_all_scoped_reset_cannot_be_redirected_after_final_validation() {
    let main = repo_with_file("discard-linked-scoped-reset", "tracked.txt", b"base\n");
    main.git_ok(&["branch", "feature"]);
    let linked = TempRepo::new("discard-linked-scoped-reset-worktree");
    std::fs::remove_dir_all(&linked.0).unwrap();
    main.git_ok(&["worktree", "add", "-q", linked.path(), "feature"]);
    let decoy = repo_with_file(
        "discard-linked-scoped-reset-decoy",
        "tracked.txt",
        b"decoy\n",
    );
    std::fs::write(linked.0.join("tracked.txt"), "approved linked edit\n").unwrap();
    let preview = preview_discard_all(linked.path()).expect("preview linked edit");
    let gitfile = linked.0.join(".git");
    let original_gitfile = std::fs::read(&gitfile).unwrap();
    let gitfile_for_hook = gitfile.clone();
    let decoy_gitdir = decoy.0.join(".git").canonicalize().unwrap();
    set_discard_all_after_tracked_scope_validation_test_hook(move || {
        std::fs::write(
            gitfile_for_hook,
            format!("gitdir: {}\n", decoy_gitdir.display()),
        )
        .unwrap();
    });

    let result = discard_all(
        linked.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    );
    std::fs::write(&gitfile, original_gitfile).unwrap();
    let error = result.expect_err("the post-reset scope check must report the retarget");

    assert!(
        error.contains("tracked changes were reset") && error.contains("scope or HEAD changed"),
        "unexpected post-reset diagnostic: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(linked.0.join("tracked.txt")).unwrap(),
        "base\n",
        "the reset must remain bound to the approved linked worktree"
    );
    assert_eq!(
        std::fs::read_to_string(decoy.0.join("tracked.txt")).unwrap(),
        "decoy\n",
        "the retargeted repository must not be mutated"
    );
    main.git_ok(&["worktree", "remove", "--force", linked.path()]);
}

#[test]
fn discard_all_exact_tree_restore_ignores_a_final_commondir_retarget() {
    let main = repo_with_file("discard-linked-scoped-common", "tracked.txt", b"base\n");
    main.git_ok(&["branch", "feature"]);
    main.git_ok(&["checkout", "-q", "-b", "other"]);
    std::fs::write(main.0.join("tracked.txt"), "other branch\n").unwrap();
    main.git_ok(&["add", "tracked.txt"]);
    main.git_ok(&["commit", "-q", "-m", "other content"]);
    let other_oid = rev_parse(&main, "HEAD");
    main.git_ok(&["checkout", "-q", "main"]);
    let linked = TempRepo::new("discard-linked-scoped-common-worktree");
    std::fs::remove_dir_all(&linked.0).unwrap();
    main.git_ok(&["worktree", "add", "-q", linked.path(), "feature"]);
    let decoy = repo_with_file(
        "discard-linked-scoped-common-decoy",
        "tracked.txt",
        b"decoy\n",
    );
    std::fs::create_dir_all(decoy.0.join(".git/refs/heads")).unwrap();
    std::fs::write(
        decoy.0.join(".git/refs/heads/feature"),
        format!("{other_oid}\n"),
    )
    .unwrap();
    std::fs::write(linked.0.join("tracked.txt"), "approved linked edit\n").unwrap();
    let preview = preview_discard_all(linked.path()).expect("preview linked edit");
    let gitfile = std::fs::read_to_string(linked.0.join(".git")).unwrap();
    let linked_gitdir = PathBuf::from(
        gitfile
            .trim()
            .strip_prefix("gitdir: ")
            .expect("linked worktree gitfile"),
    );
    let commondir_file = linked_gitdir.join("commondir");
    let original_commondir = std::fs::read(&commondir_file).unwrap();
    let commondir_for_hook = commondir_file.clone();
    let decoy_common = decoy.0.join(".git").canonicalize().unwrap();
    set_discard_all_after_tracked_scope_validation_test_hook(move || {
        std::fs::write(commondir_for_hook, format!("{}\n", decoy_common.display())).unwrap();
    });

    let result = discard_all(
        linked.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    );
    std::fs::write(&commondir_file, original_commondir).unwrap();
    let error = result.expect_err("the post-restore lease check must report the retarget");

    assert!(
        error.contains("reset to the previewed commit") && error.contains("scope or HEAD changed"),
        "unexpected post-restore diagnostic: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(linked.0.join("tracked.txt")).unwrap(),
        "base\n",
        "a retargeted branch ref must not select the restored tree"
    );
    assert_eq!(
        std::fs::read_to_string(decoy.0.join(".git/refs/heads/feature")).unwrap(),
        format!("{other_oid}\n"),
        "restoring the worktree must not update a retargeted branch ref"
    );
    main.git_ok(&["worktree", "remove", "--force", linked.path()]);
}

#[test]
fn discard_all_exact_tree_restore_ignores_a_final_head_retarget() {
    let repo = repo_with_file("discard-scoped-head", "tracked.txt", b"base\n");
    repo.git_ok(&["checkout", "-q", "-b", "other"]);
    std::fs::write(repo.0.join("tracked.txt"), "other branch\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "other content"]);
    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("tracked.txt"), "approved main edit\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview main edit");
    let head_file = repo.0.join(".git/HEAD");
    let original_head = std::fs::read(&head_file).unwrap();
    let head_for_hook = head_file.clone();
    set_discard_all_after_tracked_scope_validation_test_hook(move || {
        std::fs::write(head_for_hook, "ref: refs/heads/other\n").unwrap();
    });

    let result = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    );
    std::fs::write(&head_file, original_head).unwrap();
    let error = result.expect_err("the post-restore lease check must report the HEAD retarget");

    assert!(
        error.contains("reset to the previewed commit") && error.contains("scope or HEAD changed"),
        "unexpected post-restore diagnostic: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "base\n",
        "a retargeted HEAD must not select the restored tree"
    );
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout).trim(),
        "main"
    );
}

#[test]
fn discard_all_preview_rejects_active_replace_refs() {
    let repo = repo_with_file("discard-replace-active", "tracked.txt", b"base\n");
    let base_oid = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "-b", "replacement"]);
    std::fs::write(repo.0.join("tracked.txt"), "replacement tree\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "replacement content"]);
    let replacement_oid = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "main"]);
    repo.git_ok(&["replace", &base_oid, &replacement_oid]);
    std::fs::write(repo.0.join("tracked.txt"), "approved edit\n").unwrap();

    let error = preview_discard_all(repo.path())
        .expect_err("replacement refs can redirect trees and blobs below HEAD");

    assert!(error.contains("replacement refs are active"));
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "approved edit\n"
    );
    assert_eq!(rev_parse(&repo, "refs/heads/main"), base_oid);
    assert_eq!(
        rev_parse(&repo, &format!("refs/replace/{base_oid}")),
        replacement_oid
    );
}

#[test]
fn discard_all_preview_rejects_tree_subtree_and_blob_replace_refs() {
    let repo = TempRepo::new("discard-replace-noncommit");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::create_dir(repo.0.join("dir")).unwrap();
    std::fs::write(repo.0.join("dir/tracked.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "dir/tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["checkout", "-q", "-b", "replacement"]);
    std::fs::write(repo.0.join("dir/tracked.txt"), "replacement\n").unwrap();
    repo.git_ok(&["add", "dir/tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "replacement"]);

    let replacements = [
        (
            rev_parse(&repo, "main^{tree}"),
            rev_parse(&repo, "replacement^{tree}"),
        ),
        (
            rev_parse(&repo, "main:dir"),
            rev_parse(&repo, "replacement:dir"),
        ),
        (
            rev_parse(&repo, "main:dir/tracked.txt"),
            rev_parse(&repo, "replacement:dir/tracked.txt"),
        ),
    ];
    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("dir/tracked.txt"), "approved edit\n").unwrap();

    for (original, replacement) in replacements {
        repo.git_ok(&["replace", &original, &replacement]);
        let error = preview_discard_all(repo.path())
            .expect_err("all replacement-object types must fail closed");
        assert!(error.contains("replacement refs are active"));
        repo.git_ok(&["replace", "-d", &original]);
    }

    assert_eq!(
        std::fs::read_to_string(repo.0.join("dir/tracked.txt")).unwrap(),
        "approved edit\n"
    );
}

#[test]
fn discard_all_exact_tree_restore_ignores_a_final_replace_ref() {
    let repo = repo_with_file("discard-replace-late", "tracked.txt", b"base\n");
    let base_oid = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "-b", "replacement"]);
    std::fs::write(repo.0.join("tracked.txt"), "replacement tree\n").unwrap();
    repo.git_ok(&["add", "tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "replacement content"]);
    let replacement_oid = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("tracked.txt"), "approved edit\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview main edit");
    let replace_ref = repo.0.join(format!(".git/refs/replace/{base_oid}"));
    let replace_ref_for_hook = replace_ref.clone();
    set_discard_all_after_tracked_scope_validation_test_hook(move || {
        std::fs::create_dir_all(replace_ref_for_hook.parent().unwrap()).unwrap();
        std::fs::write(replace_ref_for_hook, format!("{replacement_oid}\n")).unwrap();
    });

    let result = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    );
    std::fs::remove_file(&replace_ref).unwrap();
    let error = result.expect_err("the post-restore lease check must report the replace ref");

    assert!(
        error.contains("reset to the previewed commit") && error.contains("scope or HEAD changed"),
        "unexpected post-restore diagnostic: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "base\n",
        "a late replace ref must not select the restored tree"
    );
    assert_eq!(rev_parse(&repo, "refs/heads/main"), base_oid);
}

#[test]
fn discard_all_rejects_a_linked_worktree_commondir_retarget_before_reset() {
    let main = repo_with_file("discard-linked-common", "tracked.txt", b"base\n");
    main.git_ok(&["branch", "feature"]);
    let linked = TempRepo::new("discard-linked-common-worktree");
    std::fs::remove_dir_all(&linked.0).unwrap();
    main.git_ok(&["worktree", "add", "-q", linked.path(), "feature"]);
    let decoy = repo_with_file("discard-linked-common-decoy", "tracked.txt", b"decoy\n");
    std::fs::write(linked.0.join("tracked.txt"), "approved linked edit\n").unwrap();
    let preview = preview_discard_all(linked.path()).expect("preview linked edit");
    let gitfile = std::fs::read_to_string(linked.0.join(".git")).unwrap();
    let linked_gitdir = PathBuf::from(
        gitfile
            .trim()
            .strip_prefix("gitdir: ")
            .expect("linked worktree gitfile"),
    );
    let commondir_file = linked_gitdir.join("commondir");
    let original_commondir = std::fs::read(&commondir_file).unwrap();
    let commondir_for_hook = commondir_file.clone();
    let decoy_common = decoy.0.join(".git").canonicalize().unwrap();
    set_discard_all_before_tracked_reset_test_hook(move || {
        std::fs::write(commondir_for_hook, format!("{}\n", decoy_common.display())).unwrap();
    });

    let result = discard_all(
        linked.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    );
    std::fs::write(&commondir_file, original_commondir).unwrap();
    let error = result.expect_err("retargeted commondir must invalidate the captured scope");

    assert!(
        error.contains("working tree changed after this confirmation"),
        "unexpected scope error: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(linked.0.join("tracked.txt")).unwrap(),
        "approved linked edit\n"
    );
    assert_eq!(
        std::fs::read_to_string(decoy.0.join("tracked.txt")).unwrap(),
        "decoy\n"
    );
    main.git_ok(&["worktree", "remove", "--force", linked.path()]);
}

#[test]
fn discard_all_preserves_tracked_edits_created_after_cleanup() {
    let repo = repo_with_file("discard-late-tracked", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("tracked.txt"), "previewed edit\n").unwrap();
    std::fs::write(repo.0.join("approved.txt"), "approved\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview");
    let tracked = repo.0.join("tracked.txt");
    let tracked_for_hook = tracked.clone();
    set_discard_all_after_cleanup_test_hook(move || {
        std::fs::write(tracked_for_hook, "late edit\n").unwrap();
    });

    let error = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("late tracked edit must stop reset");

    assert!(error.contains("cleanup completed") && error.contains("tracked edits were preserved"));
    assert!(!repo.0.join("approved.txt").exists());
    assert_eq!(std::fs::read_to_string(tracked).unwrap(), "late edit\n");
}

#[test]
fn discard_all_preserves_state_after_a_head_switch_during_cleanup() {
    let repo = repo_with_file("discard-late-head-switch", "tracked.txt", b"base\n");
    repo.git_ok(&["branch", "other"]);
    std::fs::write(repo.0.join("tracked.txt"), "previewed edit\n").unwrap();
    std::fs::write(repo.0.join("approved.txt"), "approved\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview");
    let repo_for_hook = repo.0.clone();
    set_discard_all_after_cleanup_test_hook(move || {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo_for_hook)
            .args(["switch", "-q", "other"])
            .output()
            .unwrap();
        assert!(output.status.success());
    });

    let error = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("HEAD drift must stop reset");

    assert!(error.contains("cleanup completed"));
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout).trim(),
        "other"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "previewed edit\n"
    );
    assert!(!repo.0.join("approved.txt").exists());
}

#[test]
fn discard_all_preview_rejects_assume_unchanged_files() {
    let repo = repo_with_file("discard-assume-unchanged", "tracked.txt", b"base\n");
    repo.git_ok(&["update-index", "--assume-unchanged", "tracked.txt"]);
    std::fs::write(repo.0.join("tracked.txt"), "hidden edit\n").unwrap();

    let error = preview_discard_all(repo.path())
        .expect_err("hidden tracked changes cannot be safely previewed");

    assert!(error.contains("assume-unchanged"));
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "hidden edit\n"
    );
}

#[test]
fn discard_all_preview_rejects_skip_worktree_files() {
    let repo = repo_with_file("discard-skip-worktree", "tracked.txt", b"base\n");
    repo.git_ok(&["update-index", "--skip-worktree", "tracked.txt"]);
    std::fs::write(repo.0.join("tracked.txt"), "hidden edit\n").unwrap();

    let error = preview_discard_all(repo.path())
        .expect_err("skip-worktree changes cannot be safely previewed");

    assert!(error.contains("skip-worktree"));
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "hidden edit\n"
    );
}

#[test]
fn discard_all_preview_rejects_ignored_directory_obstructions() {
    let repo = repo_with_file("discard-obstruction", "victim", b"base\n");
    std::fs::write(repo.0.join(".gitignore"), "victim/\n").unwrap();
    repo.git_ok(&["add", ".gitignore"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "ignore obstruction"]);
    repo.git_ok(&["rm", "-q", "victim"]);
    std::fs::create_dir(repo.0.join("victim")).unwrap();
    std::fs::write(repo.0.join("victim/secret"), "keep\n").unwrap();

    let error =
        preview_discard_all(repo.path()).expect_err("reset would erase an ignored descendant");

    assert!(error.contains("non-file worktree path victim"));
    assert_eq!(
        std::fs::read_to_string(repo.0.join("victim/secret")).unwrap(),
        "keep\n"
    );
}

#[test]
fn discard_all_preview_rejects_an_unstable_capture() {
    let repo = repo_with_file("discard-unstable-preview", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("tracked.txt"), "first edit\n").unwrap();
    let tracked = repo.0.join("tracked.txt");
    set_discard_all_capture_test_hook(move || {
        std::fs::write(tracked, "second edit\n").unwrap();
    });

    let error = preview_discard_all(repo.path())
        .expect_err("a preview assembled from two states must fail closed");

    assert!(error.contains("changed while GitLane was preparing"));
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "second edit\n"
    );
}

#[test]
fn discard_all_preview_bounds_large_content_fingerprinting() {
    let repo = repo_with_file("discard-large-sparse", "tracked.txt", b"base\n");
    let sparse = std::fs::File::create(repo.0.join("huge.bin")).unwrap();
    sparse.set_len(257 * 1024 * 1024).unwrap();

    let error =
        preview_discard_all(repo.path()).expect_err("oversized safety inspection must fail fast");

    assert!(error.contains("more than 256 MiB") && error.contains("terminal"));
    assert_eq!(
        std::fs::metadata(repo.0.join("huge.bin")).unwrap().len(),
        257 * 1024 * 1024
    );
}

#[test]
fn discard_all_preview_counts_overlapping_file_content_once() {
    let repo = repo_with_file("discard-overlap-budget", "victim.bin", b"base\n");
    repo.git_ok(&["rm", "-q", "victim.bin"]);
    let replacement = std::fs::File::create(repo.0.join("victim.bin")).unwrap();
    replacement.set_len(129 * 1024 * 1024).unwrap();

    let preview = preview_discard_all(repo.path())
        .expect("one overlapping file below the unique-content cap must preview");

    assert!(preview.expected_state.starts_with("v1:"));
    assert_eq!(
        std::fs::metadata(repo.0.join("victim.bin")).unwrap().len(),
        129 * 1024 * 1024
    );
}

#[test]
fn discard_all_rejects_a_submodule_dirtied_before_reset() {
    let submodule = repo_with_file("discard-submodule-source", "nested.txt", b"nested base\n");
    let repo = repo_with_file("discard-submodule-parent", "tracked.txt", b"base\n");
    repo.git_ok(&[
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        submodule.path(),
        "nested",
    ]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-am", "add submodule"]);
    repo.git_ok(&["config", "submodule.recurse", "true"]);
    std::fs::write(repo.0.join("tracked.txt"), "changed\n").unwrap();
    std::fs::write(repo.0.join("approved.txt"), "approved\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview clean submodule");
    let nested_file = repo.0.join("nested/nested.txt");
    let nested_for_hook = nested_file.clone();
    set_discard_all_after_cleanup_test_hook(move || {
        std::fs::write(nested_for_hook, "late nested edit\n").unwrap();
    });

    let error = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("late submodule state must stop the superproject reset");

    assert!(error.contains("tracked state could not be rechecked"));
    assert!(!repo.0.join("approved.txt").exists());
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "changed\n",
        "the superproject edit must survive the rejected reset"
    );
    assert_eq!(
        std::fs::read_to_string(nested_file).unwrap(),
        "late nested edit\n",
        "user config must not make reset recurse into the submodule"
    );
}

#[cfg(unix)]
#[test]
fn discard_all_uses_the_validated_worktree_when_repo_symlink_is_repointed() {
    use std::os::unix::fs::symlink;

    let approved = repo_with_file("discard-symlink-approved", "tracked.txt", b"base\n");
    std::fs::write(approved.0.join("tracked.txt"), "approved edit\n").unwrap();
    std::fs::write(approved.0.join("approved-untracked.txt"), "remove\n").unwrap();
    let other = repo_with_file("discard-symlink-other", "tracked.txt", b"other base\n");
    std::fs::write(other.0.join("tracked.txt"), "precious other edit\n").unwrap();
    std::fs::write(other.0.join("precious.txt"), "keep\n").unwrap();
    let holder = TempRepo::new("discard-symlink-holder");
    let link = holder.0.join("repo");
    symlink(&approved.0, &link).unwrap();
    let link_arg = link.to_string_lossy().into_owned();
    let preview = preview_discard_all(&link_arg).expect("preview through symlink");
    let link_for_hook = link.clone();
    let other_for_hook = other.0.clone();
    set_discard_all_after_validation_test_hook(move || {
        std::fs::remove_file(&link_for_hook).unwrap();
        symlink(other_for_hook, link_for_hook).unwrap();
    });

    discard_all(
        &link_arg,
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect("operate on the captured worktree");

    assert_eq!(
        std::fs::read_to_string(approved.0.join("tracked.txt")).unwrap(),
        "base\n"
    );
    assert!(!approved.0.join("approved-untracked.txt").exists());
    assert_eq!(
        std::fs::read_to_string(other.0.join("tracked.txt")).unwrap(),
        "precious other edit\n"
    );
    assert_eq!(
        std::fs::read_to_string(other.0.join("precious.txt")).unwrap(),
        "keep\n"
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

    discard_all_previewed(repo.path()).expect("discard_all");

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

    discard_all_previewed(repo.path()).expect("discard_all");

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

    let result =
        discard_all_previewed(repo.path()).expect("nested repositories are a protected exception");

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
fn discard_all_preserves_a_nested_repository_created_after_confirmation() {
    let repo = repo_with_file("discard-late-nested-repo", "tracked.txt", b"base\n");
    std::fs::create_dir(repo.0.join("nested")).unwrap();
    std::fs::write(repo.0.join("nested/approved.txt"), "keep\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview ordinary untracked file");
    let nested_for_hook = repo.0.join("nested");
    set_discard_all_after_validation_test_hook(move || {
        let output = Command::new("git")
            .arg("-C")
            .arg(&nested_for_hook)
            .args(["init", "-q"])
            .output()
            .unwrap();
        assert!(output.status.success());
    });

    let error = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("a newly nested repository must stop cleanup");

    assert!(error.contains("now inside nested Git repository"));
    assert_eq!(
        std::fs::read_to_string(repo.0.join("nested/approved.txt")).unwrap(),
        "keep\n"
    );
    assert!(repo.0.join("nested/.git").is_dir());
}

#[test]
fn discard_all_preserves_tracked_files_wrapped_in_a_nested_repo_after_confirmation() {
    let repo = TempRepo::new("discard-late-nested-tracked");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::create_dir(repo.0.join("nested")).unwrap();
    std::fs::write(repo.0.join("nested/tracked.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "nested/tracked.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "seed"]);
    std::fs::write(repo.0.join("nested/tracked.txt"), "approved edit\n").unwrap();
    let preview = preview_discard_all(repo.path()).expect("preview tracked edit");
    let nested_for_hook = repo.0.join("nested");
    set_discard_all_after_cleanup_test_hook(move || {
        let output = Command::new("git")
            .arg("-C")
            .arg(&nested_for_hook)
            .args(["init", "-q"])
            .output()
            .unwrap();
        assert!(output.status.success());
    });

    let error = discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("a newly nested repository must stop the parent reset");

    assert!(error.contains("now inside nested Git repository"));
    assert_eq!(
        std::fs::read_to_string(repo.0.join("nested/tracked.txt")).unwrap(),
        "approved edit\n"
    );
    assert!(repo.0.join("nested/.git").is_dir());
}

#[test]
fn discard_all_preserves_nested_bare_git_repositories() {
    let repo = repo_with_file("discard-nested-bare-repo", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("tracked.txt"), "changed\n").unwrap();
    std::fs::write(repo.0.join("ordinary.txt"), "remove\n").unwrap();
    std::fs::create_dir(repo.0.join("nested.git")).unwrap();
    repo.git_ok(&["-C", "nested.git", "init", "--bare", "-q"]);

    let preview = preview_discard_all(repo.path()).expect("preview nested bare repository");
    assert!(preview
        .details
        .iter()
        .any(|line| line.contains("Nested Git repositories") && line.contains("nested.git")));
    assert!(!preview
        .details
        .iter()
        .filter(|line| line.starts_with("Files that will be reset or removed:"))
        .any(|line| line.contains("nested.git/")));
    discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect("preserve nested bare repository");

    assert!(repo.0.join("nested.git/HEAD").is_file());
    assert!(repo.0.join("nested.git/objects").is_dir());
    assert!(!repo.0.join("ordinary.txt").exists());
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
        "base\n"
    );
}

#[test]
fn discard_all_rejects_staged_nested_bare_repository_metadata() {
    let repo = repo_with_file("discard-staged-nested-bare", "tracked.txt", b"base\n");
    std::fs::create_dir(repo.0.join("nested.git")).unwrap();
    repo.git_ok(&["-C", "nested.git", "init", "--bare", "-q"]);
    repo.git_ok(&["add", "nested.git/HEAD", "nested.git/config"]);

    let error = preview_discard_all(repo.path())
        .expect_err("parent reset must not delete staged bare-repository metadata");

    assert!(error.contains("Nested Git repository nested.git"));
    assert!(repo.0.join("nested.git/HEAD").is_file());
    assert!(repo.0.join("nested.git/config").is_file());
}

#[cfg(unix)]
#[test]
fn discard_all_preserves_directories_with_dangling_git_markers() {
    use std::os::unix::fs::symlink;

    let repo = repo_with_file("discard-dangling-git-marker", "tracked.txt", b"base\n");
    std::fs::create_dir(repo.0.join("nested")).unwrap();
    symlink("missing-gitdir", repo.0.join("nested/.git")).unwrap();
    std::fs::write(repo.0.join("nested/precious"), "keep\n").unwrap();

    let preview = preview_discard_all(repo.path()).expect("preview protected marker");
    assert!(preview
        .details
        .iter()
        .any(|line| line.contains("Nested Git repositories") && line.contains("nested")));
    assert!(!preview
        .details
        .iter()
        .filter(|line| line.starts_with("Files that will be reset or removed:"))
        .any(|line| line.contains("nested/precious")));
    discard_all(
        repo.path(),
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect("preserve marker directory");

    assert_eq!(
        std::fs::read_to_string(repo.0.join("nested/precious")).unwrap(),
        "keep\n"
    );
    assert!(std::fs::symlink_metadata(repo.0.join("nested/.git")).is_ok());
}

#[test]
fn discard_all_reports_when_reset_fails_after_untracked_cleanup() {
    let repo = repo_with_file("discard-reset-failure", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("tracked.txt"), "changed\n").unwrap();
    std::fs::write(repo.0.join("untracked.txt"), "new\n").unwrap();
    std::fs::write(repo.0.join(".git/index.lock"), "locked\n").unwrap();

    let result = discard_all_previewed(repo.path());

    std::fs::remove_file(repo.0.join(".git/index.lock")).unwrap();
    let error = result.expect_err("the index lock should block reset");
    assert!(
        error.contains(
            "Approved untracked cleanup completed, but tracked changes could not be reset"
        ),
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

    discard_all_previewed(repo.path()).expect("discard_all");

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

    discard_all_previewed(repo.path()).expect("discard_all");

    assert!(
        !path.exists(),
        "the exact leading-space path should be cleaned"
    );
}

#[cfg(not(windows))]
#[test]
fn discard_all_treats_pathspec_magic_as_a_literal_filename() {
    let repo = repo_with_file("discard-pathspec-magic", "tracked.txt", b"base\n");
    let path = repo.0.join(":(");
    std::fs::write(&path, "new\n").unwrap();

    discard_all_previewed(repo.path()).expect("discard_all");

    assert!(
        !path.exists(),
        "the pathspec-like filename should be cleaned"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn discard_all_removes_non_utf8_untracked_paths() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let repo = repo_with_file("discard-non-utf8", "tracked.txt", b"base\n");
    let path = OsStr::from_bytes(b"untracked\xff.txt");
    std::fs::write(repo.0.join(path), b"new\n").unwrap();

    discard_all_previewed(repo.path()).expect("discard_all");

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
    repo.git_ok(&["config", "branch.feature.remote", "origin"]);

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
    let expected_oid = rev_parse(&repo, "refs/heads/feature");
    let result = delete_branch_with_worktree_previewed(
        repo.path(),
        "feature",
        linked_str,
        &expected_oid,
        &|s| steps.borrow_mut().push(s),
    )
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
    assert!(
        !repo
            .git(&["config", "--get", "branch.feature.remote"])
            .status
            .success(),
        "successful deletion must remove branch-specific config"
    );

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
    repo.git_ok(&["config", "branch.feature.remote", "origin"]);

    let linked = std::env::temp_dir().join(format!(
        "gitlane-delete-worktree-branch-dirty-linked-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&linked);
    let linked_str = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", linked_str, "feature"]);
    // Make the worktree dirty so the (unforced) removal must refuse.
    std::fs::write(linked.join("file.txt"), "edited\n").unwrap();

    let expected_oid = rev_parse(&repo, "refs/heads/feature");
    let err = delete_branch_with_worktree_previewed(
        repo.path(),
        "feature",
        linked_str,
        &expected_oid,
        &|_| {},
    )
    .expect_err("dirty worktree should abort the delete");
    assert!(!err.is_empty(), "expected a git error message");

    // Nothing was destroyed: the branch and worktree both survive.
    let branches = repo.git(&["branch", "--list", "feature"]);
    assert!(
        String::from_utf8_lossy(&branches.stdout).contains("feature"),
        "feature branch must survive a refused delete"
    );
    assert!(linked.exists(), "dirty worktree directory must survive");
    assert_eq!(
        String::from_utf8_lossy(
            &repo
                .git(&["config", "--get", "branch.feature.remote"])
                .stdout
        )
        .trim(),
        "origin",
        "an aborted transaction must preserve branch config"
    );

    // Abort must release the ref lock: once the dirty edit is restored, the
    // exact same preview lease can be retried successfully.
    let restore = Command::new("git")
        .arg("-C")
        .arg(&linked)
        .args(["restore", "file.txt"])
        .output()
        .expect("git restores the linked worktree");
    assert!(restore.status.success());
    delete_branch_with_worktree_previewed(
        repo.path(),
        "feature",
        linked_str,
        &expected_oid,
        &|_| {},
    )
    .expect("retry after abort should acquire the ref lock");
    assert!(!linked.exists());

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

    let expected_oid = rev_parse(&repo, "refs/heads/feature");
    let err = delete_branch_with_worktree_previewed(
        repo.path(),
        "feature",
        linked_str,
        &expected_oid,
        &|_| {},
    )
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
fn delete_branch_with_worktree_rejects_a_stale_tip_before_removing_the_worktree() {
    let (repo, expected_oid) = repo_with_base_commit("delete-worktree-stale-tip");
    repo.git_ok(&["branch", "feature", &expected_oid]);
    let linked = std::env::temp_dir().join(format!(
        "gitlane-delete-worktree-stale-tip-linked-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&linked);
    let linked_str = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", linked_str, "feature"]);

    // Advance the checked-out branch after the preview. The worktree is clean,
    // but the old lease must fail during transaction prepare, before removal.
    std::fs::write(linked.join("next.txt"), "next\n").unwrap();
    let commit = Command::new("git")
        .arg("-C")
        .arg(&linked)
        .args(["add", "next.txt"])
        .status()
        .expect("git add launches");
    assert!(commit.success());
    let commit = Command::new("git")
        .arg("-C")
        .arg(&linked)
        .args(["commit", "-q", "-m", "advance feature"])
        .status()
        .expect("git commit launches");
    assert!(commit.success());
    let advanced_oid = rev_parse(&repo, "refs/heads/feature");
    assert_ne!(advanced_oid, expected_oid);

    let err = delete_branch_with_worktree_previewed(
        repo.path(),
        "feature",
        linked_str,
        &expected_oid,
        &|_| {},
    )
    .expect_err("stale branch tip must reject before worktree removal");
    assert!(!err.is_empty());
    assert!(linked.exists(), "stale preview must preserve the worktree");
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), advanced_oid);

    let _ = repo.git(&["worktree", "remove", "--force", linked_str]);
    let _ = std::fs::remove_dir_all(&linked);
}

#[test]
fn delete_branch_with_worktree_preserves_a_branch_claimed_after_source_removal() {
    let (repo, expected_oid) = repo_with_base_commit("delete-worktree-claimed-tip");
    repo.git_ok(&["branch", "feature", &expected_oid]);
    repo.git_ok(&["config", "branch.feature.remote", "origin"]);
    let source = std::env::temp_dir().join(format!(
        "gitlane-delete-worktree-claimed-source-{}",
        std::process::id()
    ));
    let claimant = std::env::temp_dir().join(format!(
        "gitlane-delete-worktree-claimed-other-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&source);
    let _ = std::fs::remove_dir_all(&claimant);
    let source_str = source.to_str().unwrap();
    let claimant_str = claimant.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", source_str, "feature"]);
    repo.git_ok(&["worktree", "add", "-q", "--detach", claimant_str, "main"]);

    let switched = std::cell::Cell::new(false);
    let err = delete_branch_with_worktree_previewed(
        repo.path(),
        "feature",
        source_str,
        &expected_oid,
        &|step| {
            if step == "deleteBranch" {
                let output = Command::new("git")
                    .arg("-C")
                    .arg(&claimant)
                    .args(["symbolic-ref", "HEAD", "refs/heads/feature"])
                    .output()
                    .expect("claimant symbolic-ref launches");
                assert!(
                    output.status.success(),
                    "claiming a prepared branch through worktree HEAD failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                switched.set(true);
            }
        },
    )
    .expect_err("a newly claimed branch must be preserved");

    assert!(switched.get());
    assert!(err.contains("preserved branch"), "unexpected error: {err}");
    assert!(
        !source.exists(),
        "the source was already removed at this phase"
    );
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), expected_oid);
    assert_eq!(
        String::from_utf8_lossy(
            &Command::new("git")
                .arg("-C")
                .arg(&claimant)
                .args(["branch", "--show-current"])
                .output()
                .expect("claimant branch read launches")
                .stdout
        )
        .trim(),
        "feature"
    );
    assert_eq!(
        String::from_utf8_lossy(
            &repo
                .git(&["config", "--get", "branch.feature.remote"])
                .stdout
        )
        .trim(),
        "origin",
        "preserved branch must keep its config"
    );

    let _ = repo.git(&["worktree", "remove", "--force", claimant_str]);
    let _ = std::fs::remove_dir_all(&source);
    let _ = std::fs::remove_dir_all(&claimant);
}

#[test]
fn delete_branch_cas_removes_config_but_preserves_a_same_named_tag() {
    let (repo, head) = repo_with_base_commit("delete-branch-cas");
    repo.git_ok(&["branch", "feature", &head]);
    repo.git_ok(&["tag", "feature", &head]);
    repo.git_ok(&["config", "branch.feature.remote", "origin"]);

    let result = delete_branch(repo.path(), "feature", &head, true)
        .expect("exact branch delete should succeed");
    assert_eq!(result, "Deleted feature");
    assert!(
        !repo
            .git(&["show-ref", "--verify", "--quiet", "refs/heads/feature"])
            .status
            .success(),
        "local branch ref must be gone"
    );
    assert!(
        repo.git(&["show-ref", "--verify", "--quiet", "refs/tags/feature"])
            .status
            .success(),
        "same-named tag must survive"
    );
    assert!(
        !repo
            .git(&["config", "--get", "branch.feature.remote"])
            .status
            .success(),
        "branch-specific config must be removed after ref commit"
    );
}

#[test]
fn delete_branch_without_local_config_reports_an_unqualified_success() {
    let (repo, head) = repo_with_base_commit("delete-branch-no-config");
    repo.git_ok(&["branch", "feature", &head]);

    let result = delete_branch(repo.path(), "feature", &head, true)
        .expect("a missing branch config section is already clean");

    assert_eq!(result, "Deleted feature");
}

#[test]
fn delete_branch_cas_rejects_a_tip_changed_after_preview() {
    let (repo, expected_oid) = repo_with_base_commit("delete-branch-stale-tip");
    repo.git_ok(&["branch", "feature", &expected_oid]);
    repo.git_ok(&["config", "branch.feature.remote", "origin"]);
    std::fs::write(repo.0.join("next.txt"), "next\n").unwrap();
    repo.git_ok(&["add", "next.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "next"]);
    let advanced_oid = rev_parse(&repo, "HEAD");
    repo.git_ok(&["update-ref", "refs/heads/feature", &advanced_oid]);

    let err = delete_branch(repo.path(), "feature", &expected_oid, true)
        .expect_err("stale expected oid must reject");
    assert!(!err.is_empty());
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), advanced_oid);
    assert_eq!(
        String::from_utf8_lossy(
            &repo
                .git(&["config", "--get", "branch.feature.remote"])
                .stdout
        )
        .trim(),
        "origin",
        "failed CAS must not clean branch config"
    );
}

#[test]
fn delete_branch_rejects_current_and_linked_worktree_owners() {
    let (repo, head) = repo_with_base_commit("delete-branch-checked-out");
    assert!(delete_branch(repo.path(), "main", &head, true).is_err());
    assert_eq!(rev_parse(&repo, "refs/heads/main"), head);
    assert!(
        !repo.0.join(".git/refs/heads/main.lock").exists(),
        "aborting a prepared deletion must release the current branch lock"
    );

    repo.git_ok(&["branch", "feature", &head]);
    let linked = std::env::temp_dir().join(format!(
        "gitlane-delete-branch-owner-linked-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&linked);
    let linked_str = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", linked_str, "feature"]);
    assert!(delete_branch(repo.path(), "feature", &head, true).is_err());
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), head);
    assert!(
        !repo.0.join(".git/refs/heads/feature.lock").exists(),
        "aborting a prepared deletion must release a linked-worktree branch lock"
    );

    let _ = repo.git(&["worktree", "remove", "--force", linked_str]);
    let _ = std::fs::remove_dir_all(&linked);
}

#[test]
fn delete_branch_rejects_symbolic_and_noncanonical_leases() {
    let (repo, head) = repo_with_base_commit("delete-branch-invalid-lease");
    repo.git_ok(&["branch", "feature", &head]);
    repo.git_ok(&["symbolic-ref", "refs/heads/alias", "refs/heads/feature"]);

    assert!(preview_delete_branch(repo.path(), "alias").is_err());
    assert!(delete_branch(repo.path(), "alias", &head, true).is_err());
    assert_eq!(
        String::from_utf8_lossy(
            &repo
                .git(&["symbolic-ref", "--quiet", "refs/heads/alias"])
                .stdout
        )
        .trim(),
        "refs/heads/feature"
    );
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), head);

    for invalid in ["refs/heads/feature".to_string(), format!("{head}\ncommit")] {
        assert!(
            delete_branch(repo.path(), "feature", &invalid, true).is_err(),
            "noncanonical lease {invalid:?} must reject"
        );
    }
    assert!(
        delete_branch(repo.path(), "feature\ncommit", &head, true).is_err(),
        "a branch name must never inject another update-ref protocol command"
    );
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), head);
}

#[test]
fn delete_branch_without_force_preserves_unmerged_safety() {
    let (repo, _) = repo_with_base_commit("delete-branch-unmerged");
    repo.git_ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("feature.txt"), "feature\n").unwrap();
    repo.git_ok(&["add", "feature.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "feature"]);
    let feature_oid = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "main"]);

    let err = delete_branch(repo.path(), "feature", &feature_oid, false)
        .expect_err("non-force deletion must refuse an unmerged branch");
    assert!(err.contains("not fully merged"), "unexpected error: {err}");
    assert_eq!(rev_parse(&repo, "refs/heads/feature"), feature_oid);
    delete_branch(repo.path(), "feature", &feature_oid, true)
        .expect("force deletion may remove the unmerged branch");
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
fn move_branch_to_worktree_leaves_each_worktree_its_own_empty_directories() {
    // The handoff stashes both worktrees, so it inherits the same collateral
    // deletion the Stash action does — twice. Each worktree keeps its own empty
    // directories: they are local filesystem layout, not branch content (git
    // records no empty directory anywhere), so they stay where they were rather
    // than following the branch. The destination case is a plain stash-and-
    // reapply round trip within one worktree; the source keeps the scratch
    // layout of the checkout it goes on being.
    let (repo, linked) = repo_with_feature_worktree("handoff-empty-dirs");
    std::fs::write(linked.0.join("file.txt"), "carried\n").unwrap();
    std::fs::create_dir_all(linked.0.join("source-scratch/deep")).unwrap();
    std::fs::write(repo.0.join("file.txt"), "destination edit\n").unwrap();
    std::fs::create_dir_all(repo.0.join("dest-scratch")).unwrap();

    move_branch_to_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        repo.path(),
        true,
        &|_| {},
    )
    .expect("carry handoff");

    assert!(
        linked.0.join("source-scratch/deep").is_dir(),
        "the source worktree keeps its own empty directories"
    );
    assert!(
        repo.0.join("dest-scratch").is_dir(),
        "the destination's empty directory survives its own stash round trip"
    );
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
fn move_branch_to_worktree_sees_untracked_files_even_when_status_hides_them() {
    let (repo, linked) = repo_with_feature_worktree("handoff-hidden-untracked");
    repo.git_ok(&["config", "status.showUntrackedFiles", "no"]);
    std::fs::write(linked.0.join("hidden.txt"), "carry me\n").unwrap();

    move_branch_to_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        repo.path(),
        true,
        &|_| {},
    )
    .expect("explicit porcelain status must see hidden untracked files");

    assert_eq!(
        std::fs::read_to_string(repo.0.join("hidden.txt")).unwrap(),
        "carry me\n"
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
    let done =
        continue_operation(repo.path(), "carry", None, None, None, false).expect("continue carry");
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

    let content_before = std::fs::read_to_string(repo.0.join("file.txt")).unwrap();
    assert!(
        abort_operation(repo.path(), "carry").is_err(),
        "a stale abort after finish must be refused before reset --hard"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("file.txt")).unwrap(),
        content_before
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
fn worktrees_reports_each_entry_head_oid() {
    // A detached worktree has no branch to resolve through, so the porcelain
    // `HEAD` oid is the UI's only way to locate it in the graph.
    let repo = TempRepo::new("wt-head-oid");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("f.txt"), "x\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-head-oid");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);

    let head = git_at(&repo.0, &["rev-parse", "HEAD"]);
    let head = String::from_utf8_lossy(&head.stdout).trim().to_string();

    let list = worktrees(repo.path()).expect("list worktrees");
    let detached = list.iter().find(|w| !w.is_main).expect("linked worktree");
    assert!(detached.branch.is_none(), "worktree should be detached");
    assert_eq!(detached.head.as_deref(), Some(head.as_str()));
    // Branch-holding entries carry their HEAD oid too (the default-branch name
    // depends on the host's init.defaultBranch, so only its presence is checked).
    let main_entry = list.iter().find(|w| w.is_main).expect("main entry");
    assert!(main_entry.branch.is_some(), "main should be on a branch");
    assert_eq!(main_entry.head.as_deref(), Some(head.as_str()));
}

#[test]
fn create_branch_in_worktree_attaches_the_detached_worktree() {
    let (repo, linked) = repo_with_feature_worktree("wt-create-branch");
    git_ok_at(&linked.0, &["checkout", "-q", "--detach"]);
    let expected_oid = rev_parse(&repo, "feature");

    let message = create_branch_in_worktree(
        repo.path(),
        linked.as_str(),
        "topic/from-detached",
        &expected_oid,
    )
    .expect("create and check out branch in detached worktree");

    assert!(message.contains("topic/from-detached"), "got: {message}");
    let branch = git_at(&linked.0, &["branch", "--show-current"]);
    assert_eq!(
        String::from_utf8_lossy(&branch.stdout).trim(),
        "topic/from-detached"
    );
    assert_eq!(rev_parse(&repo, "topic/from-detached"), expected_oid);
}

#[test]
fn create_branch_in_worktree_rejects_a_stale_detached_head() {
    let (repo, linked) = repo_with_feature_worktree("wt-create-branch-stale");
    git_ok_at(&linked.0, &["checkout", "-q", "--detach"]);
    let expected_oid = rev_parse(&repo, "feature");

    std::fs::write(repo.0.join("later.txt"), "later\n").unwrap();
    repo.git_ok(&["add", "later.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "later"]);
    git_ok_at(&linked.0, &["checkout", "-q", "--detach", "main"]);

    let err = create_branch_in_worktree(repo.path(), linked.as_str(), "topic/stale", &expected_oid)
        .expect_err("stale menu HEAD should be rejected");
    assert!(err.contains("HEAD changed"), "got: {err}");
    assert!(
        !git_at(
            &repo.0,
            &["show-ref", "--verify", "--quiet", "refs/heads/topic/stale"]
        )
        .status
        .success(),
        "the rejected action must not create the branch"
    );
}

#[test]
fn create_branch_in_worktree_rejects_an_attached_worktree() {
    let (repo, linked) = repo_with_feature_worktree("wt-create-branch-attached");
    let expected_oid = rev_parse(&repo, "feature");

    let err = create_branch_in_worktree(
        repo.path(),
        linked.as_str(),
        "topic/already-attached",
        &expected_oid,
    )
    .expect_err("branch-holding worktree should be rejected");
    assert!(err.contains("no longer detached"), "got: {err}");
}

#[cfg(unix)]
#[test]
fn worktrees_preserves_newlines_in_worktree_paths() {
    let repo = repo_with_file("wt-newline-path", "f.txt", b"x\n");
    let linked = std::env::temp_dir().join(format!(
        "gitlane-wt-newline-{}\nsecond-line",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&linked);
    let linked_str = linked.to_str().unwrap();
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked_str]);

    let list = worktrees(repo.path()).expect("NUL-safe worktree list");
    assert!(list.iter().any(|entry| same_path(&entry.path, linked_str)));

    repo.git_ok(&["worktree", "remove", "--force", linked_str]);
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

    // After the lease matches, the server derives `-f -f` for a locked worktree
    // (GL-303) — execute has no client force flag to forget.
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview locked");
    assert!(preview.requires_force);
    assert!(preview.locked);
    remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect("force-remove a locked worktree");
    assert!(
        !linked.0.exists(),
        "the locked worktree directory should be gone after a forced remove"
    );
}

// GL-296: the probe that lets the removal confirm quote what a forced remove
// would destroy, instead of dead-ending on git's "contains modified or
// untracked files" refusal.
#[test]
fn worktree_dirty_state_counts_modified_and_untracked_work() {
    let repo = TempRepo::new("wt-dirty");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    std::fs::write(repo.0.join("b.txt"), "b\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-dirty");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);

    // A freshly added worktree is clean.
    let clean = worktree_dirty_state(linked.as_str()).expect("probe a clean worktree");
    assert_eq!((clean.modified, clean.untracked), (0, 0));

    // Two tracked edits plus untracked files nested in a new directory. The
    // probe must expand that directory (`--untracked-files=all`) rather than
    // collapsing it to a single entry, or the warning understates the loss.
    std::fs::write(linked.0.join("a.txt"), "changed\n").unwrap();
    std::fs::write(linked.0.join("b.txt"), "changed too\n").unwrap();
    std::fs::create_dir(linked.0.join("fresh")).unwrap();
    std::fs::write(linked.0.join("fresh/one.txt"), "1\n").unwrap();
    std::fs::write(linked.0.join("fresh/two.txt"), "2\n").unwrap();

    let dirty = worktree_dirty_state(linked.as_str()).expect("probe a dirty worktree");
    assert_eq!(
        (dirty.modified, dirty.untracked),
        (2, 2),
        "expected 2 modified and 2 untracked (directory expanded), got {dirty:?}"
    );

    // Review finding: `run_git` returns stdout and stderr combined on success,
    // so anything git writes to stderr must not be scored as a changed file.
    // Renames and conflict codes are one record each and stay counted.
    assert!(!is_porcelain_record("warning: unable to access something"));
    assert!(!is_porcelain_record("fatal: not a git repository"));
    assert!(!is_porcelain_record(""));
    assert!(!is_porcelain_record("   "));
    assert!(is_porcelain_record("?? new.txt"));
    assert!(is_porcelain_record(" M tracked.txt"));
    assert!(is_porcelain_record("R  old.txt -> new.txt"));
    assert!(is_porcelain_record("UU conflicted.txt"));
    assert!(is_porcelain_record("A  added.txt"));
    assert!(is_porcelain_record("D  deleted.txt"));

    // The probe is a read: it must not itself disturb the worktree. After the
    // lease matches, the server derives `--force` for dirty removals (GL-303).
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview dirty");
    assert!(preview.requires_force);
    assert_eq!(preview.dirty.modified, 2);
    assert_eq!(preview.dirty.untracked, 2);
    remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect("force-remove a dirty worktree");
    assert!(!linked.0.exists(), "the worktree directory should be gone");
}

// Ignored files are invisible to `--untracked-files=all`, yet git deletes them
// on an *unforced* remove. Without a separate count, a worktree holding only a
// local `.env` reports "nothing to lose" and is swept away with it.
#[test]
fn worktree_dirty_state_counts_ignored_entries_git_would_delete() {
    let repo = TempRepo::new("wt-ignored");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join(".gitignore"), "secret.env\nbuild/\n").unwrap();
    repo.git_ok(&["add", ".gitignore"]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-ignored");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    std::fs::write(linked.0.join("secret.env"), "TOKEN=1\n").unwrap();
    std::fs::create_dir(linked.0.join("build")).unwrap();
    for name in ["a.o", "b.o", "c.o"] {
        std::fs::write(linked.0.join("build").join(name), "x").unwrap();
    }

    let state = worktree_dirty_state(linked.as_str()).expect("probe an ignored-only worktree");
    assert_eq!(
        (state.modified, state.untracked),
        (0, 0),
        "ignored files are neither modified nor untracked: {state:?}"
    );
    // The file plus the *collapsed* build/ directory — not the three .o files
    // inside it, which `--ignored` alone deliberately does not expand.
    assert_eq!(
        state.ignored, 2,
        "expected secret.env + collapsed build/, got {state:?}"
    );

    // Git considers this worktree clean, so the unforced removal the bulk sweep
    // uses does delete those files. That is precisely why the count must be
    // reported instead of assumed to be zero.
    remove_worktree_previewed(repo.path(), linked.as_str())
        .expect("git removes an ignored-only worktree without a force");
    assert!(!linked.0.exists(), "the worktree directory should be gone");
}

#[test]
fn preview_remove_worktree_lease_ignored_only_drift_does_not_invalidate() {
    let repo = TempRepo::new("wt-lease-drift");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join(".gitignore"), "secret.env\n").unwrap();
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-lease-drift");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);

    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview clean");
    assert!(!preview.requires_force);
    assert_eq!(preview.dirty.ignored, 0);

    std::fs::write(linked.0.join("secret.env"), "TOKEN=1\n").unwrap();
    // Ignored-only drift must not invalidate the lease (disclosure only).
    remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect("ignored-only drift does not invalidate");
}

#[test]
fn preview_remove_worktree_lease_rejects_new_untracked_path() {
    let repo = TempRepo::new("wt-lease-untracked");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-lease-untracked");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview");
    std::fs::write(linked.0.join("new.txt"), "x\n").unwrap();
    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("new untracked path must invalidate");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
    assert!(
        linked.0.exists(),
        "stale lease must not remove the worktree"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}

#[test]
fn preview_remove_worktree_lease_rejects_lock_drift() {
    let repo = TempRepo::new("wt-lease-lock");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-lease-lock");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview unlocked");
    assert!(!preview.locked);
    assert!(!preview.requires_force);

    repo.git_ok(&["worktree", "lock", linked.as_str()]);
    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("locking after preview must invalidate the lease");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
    // Worktree must still exist — execute must not escalate to -f -f off-lease.
    assert!(
        linked.0.exists(),
        "lock drift must refuse, not force-remove"
    );
    repo.git_ok(&["worktree", "remove", "--force", "--force", linked.as_str()]);
}

#[test]
fn preview_remove_worktree_lease_rejects_gitdir_registration_replacement() {
    use std::path::PathBuf;

    let repo = TempRepo::new("wt-lease-gitdir");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-lease-gitdir");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview");

    // Recreate the private admin gitdir at the same pathname so the workdir
    // inode is unchanged but registration identity (gitdir inode) flips — the
    // ADR's registration half of the lease must fail closed.
    let gitfile = std::fs::read_to_string(linked.0.join(".git")).unwrap();
    let gitdir = PathBuf::from(
        gitfile
            .trim()
            .strip_prefix("gitdir: ")
            .expect("linked worktree gitfile"),
    );
    let gitdir = if gitdir.is_absolute() {
        gitdir
    } else {
        linked.0.join(gitdir)
    };
    let gitdir = gitdir.canonicalize().unwrap();
    let backup = LinkedDir::new("wt-lease-gitdir-bak");
    std::fs::create_dir_all(&backup.0).unwrap();
    copy_dir_recursive(&gitdir, &backup.0).expect("backup private gitdir");
    std::fs::remove_dir_all(&gitdir).expect("drop old gitdir inode");
    std::fs::create_dir_all(&gitdir).expect("new gitdir inode");
    copy_dir_recursive(&backup.0, &gitdir).expect("restore admin contents");

    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("replaced registration must invalidate the lease");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
    assert!(
        linked.0.exists(),
        "stale lease must not remove the worktree"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}

/// A repo whose linked worktree is already dirty at preview time, for the drift
/// tests that need an existing porcelain record to mutate. Returns the repo, the
/// linked directory, and the tracked file inside it.
fn repo_with_dirty_linked_worktree(tag: &str) -> (TempRepo, LinkedDir, PathBuf) {
    let repo = TempRepo::new(tag);
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new(tag);
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    let tracked = linked.0.join("a.txt");
    std::fs::write(&tracked, "edited once\n").unwrap();
    (repo, linked, tracked)
}

// The lease deliberately fingerprints porcelain *path + status*, not file bytes:
// typing more into an already-modified file must not expire a confirm the user
// is looking at. This is the half a leaf-byte fingerprint would have broken,
// which is why the removal lease deliberately does not reuse Discard All's.
#[test]
fn preview_remove_worktree_lease_survives_same_status_in_place_edit() {
    let (repo, linked, tracked) = repo_with_dirty_linked_worktree("wt-lease-inplace");

    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview dirty");
    assert!(preview.requires_force, "an edited tracked file is dirty");
    assert_eq!(preview.dirty.modified, 1);

    // Same path, same ` M` status code — only the bytes differ.
    std::fs::write(&tracked, "edited again, at greater length\n").unwrap();

    remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect("an in-place edit keeping the same porcelain status must not invalidate");
    assert!(!linked.0.exists(), "the worktree directory should be gone");
}

// The other side of the same line: staging that file changes ` M` to `M `, which
// is a different porcelain record and must expire the confirm even though the
// path set and the dirty *count* are both unchanged.
#[test]
fn preview_remove_worktree_lease_rejects_status_code_change() {
    let (repo, linked, _tracked) = repo_with_dirty_linked_worktree("wt-lease-status");

    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview dirty");
    assert_eq!(preview.dirty.modified, 1);

    git_ok_at(&linked.0, &["add", "a.txt"]);

    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("a status-code change must invalidate the lease");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
    assert!(
        linked.0.exists(),
        "stale lease must not remove the worktree"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}

#[test]
fn preview_remove_worktree_lease_rejects_head_movement() {
    let repo = TempRepo::new("wt-lease-head");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-lease-head");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview");
    assert!(
        preview.head_oid.is_some(),
        "detached worktrees lease a HEAD"
    );

    // Commit inside the worktree: the tree is clean again afterwards, so only
    // the leased HEAD oid catches this.
    std::fs::write(linked.0.join("b.txt"), "b\n").unwrap();
    git_ok_at(&linked.0, &["add", "b.txt"]);
    git_ok_at(
        &linked.0,
        &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "moved"],
    );

    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("HEAD movement must invalidate the lease");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
    assert!(
        linked.0.exists(),
        "stale lease must not remove the worktree"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}

// Story 8: attach↔detach must invalidate even though the path, the contents and
// the commit all stay put — only the branch half of the lease moves.
#[test]
fn preview_remove_worktree_lease_rejects_attach_to_detach() {
    let repo = TempRepo::new("wt-lease-detach");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["branch", "-M", "main"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);
    repo.git_ok(&["branch", "feature"]);

    let linked = LinkedDir::new("wt-lease-detach");
    repo.git_ok(&["worktree", "add", "-q", linked.as_str(), "feature"]);
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview attached");
    assert_eq!(preview.branch.as_deref(), Some("feature"));

    // Same commit, no branch — the HEAD oid alone would not notice.
    git_ok_at(&linked.0, &["checkout", "-q", "--detach"]);

    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("detaching after preview must invalidate the lease");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
    assert!(
        linked.0.exists(),
        "stale lease must not remove the worktree"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}

// Path Reuse / ABA, workdir half (story 6's headline scenario): the directory at
// the leased path is destroyed and rebuilt with identical contents, so only the
// filesystem identity in the fingerprint can tell the replacement apart.
#[test]
fn preview_remove_worktree_lease_rejects_workdir_directory_replacement() {
    let repo = TempRepo::new("wt-lease-workdir-aba");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-lease-workdir-aba");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview");

    // Rebuild the workdir at the same pathname with the same bytes: registration
    // and porcelain output are unchanged, the directory inode is not.
    let backup = LinkedDir::new("wt-lease-workdir-aba-bak");
    copy_dir_recursive(&linked.0, &backup.0).expect("back up the workdir");
    std::fs::remove_dir_all(&linked.0).expect("drop the old workdir inode");
    copy_dir_recursive(&backup.0, &linked.0).expect("rebuild the workdir");

    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("a replaced workdir must invalidate the lease");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
    assert!(
        linked.0.exists(),
        "stale lease must not remove the worktree"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}

// Story 7: a prune between confirm and execute drops the registration, so the
// lease must fail closed rather than run a removal against a missing worktree.
#[test]
fn preview_remove_worktree_lease_rejects_concurrent_prune() {
    let repo = TempRepo::new("wt-lease-prune");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-lease-prune");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview");

    std::fs::remove_dir_all(&linked.0).expect("simulate the directory going away");
    repo.git_ok(&["worktree", "prune"]);

    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("a pruned registration must invalidate the lease");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
}

fn copy_dir_recursive(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

#[test]
fn delete_branch_with_worktree_refuses_dirty_lease_before_removal() {
    let repo = TempRepo::new("delete-wt-dirty-lease");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["branch", "-M", "main"]);
    std::fs::write(repo.0.join("file.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    repo.git_ok(&["branch", "feature"]);

    let linked = LinkedDir::new("delete-wt-dirty-lease");
    repo.git_ok(&["worktree", "add", "-q", linked.as_str(), "feature"]);
    std::fs::write(linked.0.join("file.txt"), "edited\n").unwrap();

    let expected_oid = rev_parse(&repo, "refs/heads/feature");
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview dirty");
    assert!(preview.requires_force);
    let err = delete_branch_with_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        &expected_oid,
        &preview.expected_state,
        &|_| {},
    )
    .expect_err("combined path must refuse dirty lease");
    assert!(err.contains("cannot force-remove"), "got: {err}");
    assert!(linked.0.exists());
    assert!(
        repo.git(&["show-ref", "--verify", "--quiet", "refs/heads/feature"])
            .status
            .success(),
        "branch must survive"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}

// The locked half of the combined path's refusal — dirty was already covered,
// but a lock is the other way `requiresForce` goes true, and the combined path
// must never waive it.
#[test]
fn delete_branch_with_worktree_refuses_locked_lease_before_removal() {
    let repo = TempRepo::new("delete-wt-locked-lease");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["branch", "-M", "main"]);
    std::fs::write(repo.0.join("file.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    repo.git_ok(&["branch", "feature"]);

    let linked = LinkedDir::new("delete-wt-locked-lease");
    repo.git_ok(&["worktree", "add", "-q", linked.as_str(), "feature"]);
    repo.git_ok(&["worktree", "lock", linked.as_str()]);

    let expected_oid = rev_parse(&repo, "refs/heads/feature");
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview locked");
    assert!(preview.locked);
    assert!(preview.requires_force);

    let err = delete_branch_with_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        &expected_oid,
        &preview.expected_state,
        &|_| {},
    )
    .expect_err("combined path must refuse a locked lease");
    assert!(err.contains("cannot force-remove"), "got: {err}");
    assert!(linked.0.exists());
    assert!(
        repo.git(&["show-ref", "--verify", "--quiet", "refs/heads/feature"])
            .status
            .success(),
        "branch must survive"
    );
    repo.git_ok(&["worktree", "remove", "--force", "--force", linked.as_str()]);
}

// Story 24: a stale worktree lease must leave *both* halves alone. The combined
// path prepares a branch-deletion ref transaction before it removes the
// worktree, so a refusal after that point has to abort the transaction too —
// otherwise a stale confirm ends with the branch gone and the worktree still
// there.
#[test]
fn delete_branch_with_worktree_stale_worktree_lease_keeps_branch_and_worktree() {
    let repo = TempRepo::new("delete-wt-stale-lease");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["branch", "-M", "main"]);
    std::fs::write(repo.0.join("file.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    repo.git_ok(&["branch", "feature"]);

    let linked = LinkedDir::new("delete-wt-stale-lease");
    repo.git_ok(&["worktree", "add", "-q", linked.as_str(), "feature"]);

    let expected_oid = rev_parse(&repo, "refs/heads/feature");
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview clean");
    assert!(!preview.requires_force);

    // Drift after the confirm opened: a new untracked path the lease never saw.
    std::fs::write(linked.0.join("scratch.txt"), "unsaved\n").unwrap();

    let err = delete_branch_with_worktree(
        repo.path(),
        "feature",
        linked.as_str(),
        &expected_oid,
        &preview.expected_state,
        &|_| {},
    )
    .expect_err("combined path must refuse a drifted worktree lease");
    assert!(
        err.contains("changed after this confirmation") || err.contains("cannot force-remove"),
        "got: {err}"
    );
    assert!(linked.0.exists(), "the worktree must survive");
    assert!(
        linked.0.join("scratch.txt").exists(),
        "the drifted work must survive"
    );
    assert!(
        repo.git(&["show-ref", "--verify", "--quiet", "refs/heads/feature"])
            .status
            .success(),
        "the branch must survive an aborted combined deletion"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}

// The graph's dirty dot: one bit per worktree, on a cheaper probe than the
// removal confirm's counts. What it must *not* dot is the interesting half —
// ignored files are git-disposable, so a worktree holding only a build
// directory is not "unsaved work".
#[test]
fn worktree_is_dirty_flags_real_work_but_not_ignored_files() {
    let repo = TempRepo::new("wt-is-dirty");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join(".gitignore"), "build/\n").unwrap();
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-is-dirty");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    assert!(
        !worktree_is_dirty(linked.as_str()).expect("probe a clean worktree"),
        "a freshly added worktree has no uncommitted work"
    );

    // Ignored output only: git deletes it on an unforced remove, so it must not
    // read as unsaved work.
    std::fs::create_dir(linked.0.join("build")).unwrap();
    std::fs::write(linked.0.join("build/out.o"), "x").unwrap();
    assert!(
        !worktree_is_dirty(linked.as_str()).expect("probe an ignored-only worktree"),
        "ignored entries must not dot a worktree"
    );

    // A tracked edit is work.
    std::fs::write(linked.0.join("a.txt"), "changed\n").unwrap();
    assert!(
        worktree_is_dirty(linked.as_str()).expect("probe a modified worktree"),
        "a modified tracked file is uncommitted work"
    );

    // So is an untracked file — even nested, where `--untracked-files=normal`
    // reports the collapsed directory rather than the file. One record is all
    // the answer needs, which is why the probe can afford to collapse.
    git_ok_at(&linked.0, &["checkout", "--", "a.txt"]);
    std::fs::create_dir(linked.0.join("fresh")).unwrap();
    std::fs::write(linked.0.join("fresh/note.txt"), "1\n").unwrap();
    assert!(
        worktree_is_dirty(linked.as_str()).expect("probe an untracked-only worktree"),
        "an untracked file nested in a new directory is uncommitted work"
    );

    // Staged-but-uncommitted work counts too — it is exactly what a forced
    // remove would throw away.
    std::fs::remove_dir_all(linked.0.join("fresh")).unwrap();
    std::fs::write(linked.0.join("staged.txt"), "s\n").unwrap();
    git_ok_at(&linked.0, &["add", "staged.txt"]);
    assert!(
        worktree_is_dirty(linked.as_str()).expect("probe a staged-only worktree"),
        "staged-but-uncommitted work is uncommitted work"
    );

    // A worktree whose directory is gone errors rather than answering "clean".
    // The frontend degrades that to "no dot" — a false negative, which is the
    // safe direction for a hint: it never claims work is saved when it isn't.
    std::fs::remove_dir_all(&linked.0).unwrap();
    assert!(
        worktree_is_dirty(linked.as_str()).is_err(),
        "a missing worktree directory must not report clean"
    );
}

// A conflicted merge is the state most worth a dot — the worktree is mid-merge
// with unresolved files, and a forced removal there loses the resolution work.
#[test]
fn worktree_is_dirty_flags_an_unresolved_conflict() {
    let repo = TempRepo::new("wt-dirty-conflict");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);
    repo.git_ok(&["checkout", "-q", "-b", "other"]);
    std::fs::write(repo.0.join("a.txt"), "other\n").unwrap();
    repo.git_ok(&["commit", "-q", "-am", "other"]);
    repo.git_ok(&["checkout", "-q", "-"]);
    std::fs::write(repo.0.join("a.txt"), "main\n").unwrap();
    repo.git_ok(&["commit", "-q", "-am", "main"]);

    let linked = LinkedDir::new("wt-dirty-conflict");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    // Conflict inside the *linked* worktree, leaving `UU` records behind.
    let merge = git_at(&linked.0, &["merge", "other"]);
    assert!(!merge.status.success(), "the merge is expected to conflict");
    assert!(
        worktree_is_dirty(linked.as_str()).expect("probe a conflicted worktree"),
        "an unresolved conflict is uncommitted work"
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
            "-c",
            "diff.suppressBlankEmpty=false",
            "--literal-pathspecs",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
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
            "-c",
            "diff.suppressBlankEmpty=false",
            "--literal-pathspecs",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
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

#[cfg(not(windows))]
#[test]
fn exact_file_staging_treats_pathspec_magic_as_a_literal_filename() {
    let repo = repo_with_file("stage-pathspec-magic", "tracked.txt", b"base\n");
    let magic = ":(glob)z*";
    std::fs::write(repo.0.join(magic), "base\n").unwrap();
    std::fs::write(repo.0.join("z-victim.txt"), "base\n").unwrap();

    stage_file(repo.path(), magic).expect("stage literal magic filename");

    let staged = repo.git(&["diff", "--cached", "--name-only"]);
    assert_eq!(String::from_utf8_lossy(&staged.stdout).trim(), magic);
    let status = repo.git(&["status", "--porcelain", "--untracked-files=all"]);
    let status = String::from_utf8_lossy(&status.stdout);
    assert!(status.contains("?? z-victim.txt"), "{status}");

    unstage_file(repo.path(), magic).expect("unstage literal magic filename");
    stage_files(repo.path(), &[magic.to_string()]).expect("bulk-stage literal magic filename");
    stage_file(repo.path(), "z-victim.txt").expect("stage unrelated file");
    unstage_files(repo.path(), &[magic.to_string()]).expect("bulk-unstage literal magic filename");
    let staged = repo.git(&["diff", "--cached", "--name-only"]);
    assert_eq!(
        String::from_utf8_lossy(&staged.stdout).trim(),
        "z-victim.txt"
    );

    stage_file(repo.path(), magic).expect("re-stage literal magic filename");
    unstage_file(repo.path(), magic).expect("single-unstage literal magic filename");
    let staged = repo.git(&["diff", "--cached", "--name-only"]);
    assert_eq!(
        String::from_utf8_lossy(&staged.stdout).trim(),
        "z-victim.txt"
    );
}

#[cfg(not(windows))]
#[test]
fn hunk_staging_uses_the_literal_file_not_a_pathspec_match() {
    let magic = ":(glob)z*";
    let repo = TempRepo::new("hunk-pathspec-magic");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join(magic), "base\n").unwrap();
    std::fs::write(repo.0.join("z-victim.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "-A"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join(magic), "changed\n").unwrap();
    std::fs::write(repo.0.join("z-victim.txt"), "changed\n").unwrap();

    apply_hunk(
        repo.path(),
        magic,
        false,
        0,
        "@@ -1 +1 @@",
        "-base\n+changed",
    )
    .expect("stage hunk in literal magic filename");

    let staged = repo.git(&["diff", "--cached", "--name-only"]);
    assert_eq!(String::from_utf8_lossy(&staged.stdout).trim(), magic);
    let unstaged = repo.git(&["diff", "--name-only"]);
    assert_eq!(
        String::from_utf8_lossy(&unstaged.stdout).trim(),
        "z-victim.txt"
    );
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
    // With neither HEAD nor any branch ref, there are no recovery points.
    let repo = TempRepo::new("reflog-empty");
    repo.git(&["init", "-q", "-b", "main"]);
    let entries = reflog_entries(repo.path(), 12).expect("reflog entries on empty repo");
    assert!(entries.is_empty());
}

#[test]
fn reflog_entries_keep_branch_recovery_points_on_an_unborn_orphan_head() {
    let repo = repo_with_file("reflog-orphan", "f.txt", b"base\n");
    repo.git_ok(&["checkout", "--orphan", "empty"]);
    repo.git_ok(&["rm", "-q", "-rf", "."]);

    assert!(!repo
        .git(&["rev-parse", "--verify", "HEAD"])
        .status
        .success());
    let entries = reflog_entries(repo.path(), 12).expect("branch reflog entries");
    assert!(
        entries
            .iter()
            .any(|entry| entry.selector.contains("main@{")),
        "main's recovery reflog must remain visible: {entries:?}"
    );
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
    assert!(
        preview
            .expected_state
            .as_deref()
            .is_some_and(|s| s.starts_with("v2:")),
        "hard preview must mint an exact-state lease"
    );
    assert_eq!(preview.target_oid, rev_parse(&repo, "HEAD~1"));
    let head = rev_parse(&repo, "HEAD");
    assert_eq!(preview.expected_source_oid.as_deref(), Some(head.as_str()));
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
    // The preview is now the only place an ambiguous target is qualified to
    // refs/heads/ — the write executes the oid resolved here — so this is what
    // stops the confirm dialog describing the tag while the reset lands on the
    // branch (GL-120 review; sole owner of the qualification since GL-302).
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
    std::fs::write(repo.0.join(".git/info/exclude"), b"restored.txt\n").unwrap();
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
        "hard-reset preview must list ignored/untracked target obstructions: {full}"
    );
    assert!(
        !full.contains("untracked.txt"),
        "hard-reset preview must not list ordinary untracked files: {full}"
    );
}

#[test]
fn hard_reset_rejects_worktree_drift_before_mutating() {
    let repo = TempRepo::new("hard-reset-stale-worktree");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["commit", "-qam", "two"]);
    std::fs::write(repo.0.join("f.txt"), b"dirty\n").unwrap();
    let target = rev_parse(&repo, "HEAD~1");
    let source = rev_parse(&repo, "HEAD");
    let preview = preview_reset(repo.path(), &target, "hard", "HEAD").expect("preview");

    std::fs::write(repo.0.join("f.txt"), b"drifted\n").unwrap();
    let error = reset_branch(
        repo.path(),
        Some("main"),
        Some(&source),
        &target,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("worktree drift must expire the lease");

    assert!(
        error.contains("changed after this confirmation"),
        "unexpected error: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("f.txt")).unwrap(),
        "drifted\n"
    );
    assert_eq!(rev_parse(&repo, "HEAD"), source);
}

#[test]
fn hard_reset_rejects_staged_drift_before_mutating() {
    let repo = TempRepo::new("hard-reset-stale-index");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["commit", "-qam", "two"]);
    let target = rev_parse(&repo, "HEAD~1");
    let source = rev_parse(&repo, "HEAD");
    let preview = preview_reset(repo.path(), &target, "hard", "HEAD").expect("preview");

    std::fs::write(repo.0.join("staged.txt"), b"new\n").unwrap();
    repo.git_ok(&["add", "staged.txt"]);
    let error = reset_branch(
        repo.path(),
        Some("main"),
        Some(&source),
        &target,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("index drift must expire the lease");

    assert!(
        error.contains("changed after this confirmation"),
        "unexpected error: {error}"
    );
    assert_eq!(rev_parse(&repo, "HEAD"), source);
    assert!(repo.0.join("staged.txt").exists());
}

#[test]
fn hard_reset_rejects_head_movement_before_mutating() {
    let repo = TempRepo::new("hard-reset-stale-head");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["commit", "-qam", "two"]);
    let target = rev_parse(&repo, "HEAD~1");
    let source = rev_parse(&repo, "HEAD");
    let preview = preview_reset(repo.path(), &target, "hard", "HEAD").expect("preview");

    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "three"]);
    let error = reset_branch(
        repo.path(),
        Some("main"),
        Some(&source),
        &target,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("HEAD movement must abort before hard reset");

    // Tip CAS runs before the mutation-boundary lease check, so a moved branch
    // fails closed on the expected-oid probe.
    assert!(
        error.contains("changed from") || error.contains("Refresh and try again"),
        "unexpected error: {error}"
    );
    assert_ne!(rev_parse(&repo, "HEAD"), target);
}

#[test]
fn hard_reset_revalidates_path_observations_after_the_content_pass() {
    // Fingerprinting a set of files is not atomic. A leaf hashed early can be
    // rewritten while later leaves are still being read, and the token would
    // then carry its pre-edit digest — so only the cheap observation sweep at
    // the end of the pass can catch it. Same-size content keeps length and mode
    // identical, leaving inode/timestamps as the only signal.
    let repo = TempRepo::new("hard-reset-leaf-recheck");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["commit", "-qam", "two"]);
    let target = rev_parse(&repo, "HEAD~1");
    // Dirty, so it is fingerprinted and would be destroyed by the reset.
    std::fs::write(repo.0.join("f.txt"), b"dirty\n").unwrap();

    let preview = preview_reset(repo.path(), &target, "hard", "HEAD").expect("preview");

    let edited = repo.0.join("f.txt");
    set_hard_reset_after_fingerprint_test_hook(move || {
        // Same byte length, after this path was hashed in the boundary capture.
        std::fs::write(&edited, b"LATE!\n").unwrap();
    });

    let error = reset_branch(
        repo.path(),
        Some("main"),
        preview.expected_source_oid.as_deref(),
        &preview.target_oid,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("the observation sweep must reject an edit made after hashing");
    assert!(
        error.contains("changed after this confirmation"),
        "unexpected error: {error}"
    );
    assert_eq!(
        std::fs::read(repo.0.join("f.txt")).unwrap(),
        b"LATE!\n",
        "the late edit must survive — nothing may be reset"
    );
}

#[test]
fn hard_reset_mutates_the_validated_scope_after_a_late_gitfile_retarget() {
    // Validation proves one gitdir/worktree pair; the reset must then run
    // pinned to it. Retargeting the gitfile in the window between the two would
    // otherwise let git re-resolve the scope and reset somewhere unleased.
    let main = TempRepo::new("hard-reset-late-retarget-main");
    main.git_ok(&["init", "-q", "-b", "main"]);
    main.git_ok(&["config", "user.email", "t@t.t"]);
    main.git_ok(&["config", "user.name", "T"]);
    main.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(main.0.join("f.txt"), b"one\n").unwrap();
    main.git_ok(&["add", "f.txt"]);
    main.git_ok(&["commit", "-qm", "one"]);
    std::fs::write(main.0.join("f.txt"), b"two\n").unwrap();
    main.git_ok(&["commit", "-qam", "two"]);
    main.git_ok(&["branch", "feature"]);
    let linked = TempRepo::new("hard-reset-late-retarget-wt");
    std::fs::remove_dir_all(&linked.0).unwrap();
    main.git_ok(&["worktree", "add", "-q", linked.path(), "feature"]);

    let target = rev_parse(&main, "main~1");
    let source = rev_parse(&linked, "HEAD");
    let preview = preview_reset(linked.path(), &target, "hard", "HEAD").expect("preview");

    let decoy = TempRepo::new("hard-reset-late-retarget-decoy");
    decoy.git_ok(&["init", "-q", "-b", "main"]);
    decoy.git_ok(&["config", "user.email", "t@t.t"]);
    decoy.git_ok(&["config", "user.name", "T"]);
    decoy.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(decoy.0.join("f.txt"), b"decoy\n").unwrap();
    decoy.git_ok(&["add", "f.txt"]);
    decoy.git_ok(&["commit", "-qm", "decoy"]);
    let gitfile = linked.0.join(".git");
    let original = std::fs::read(&gitfile).unwrap();
    let decoy_gitdir = decoy.0.join(".git").canonicalize().unwrap();
    let gitfile_for_hook = gitfile.clone();
    // Retarget AFTER the lease validated — too late for the lease to catch.
    set_hard_reset_after_validation_test_hook(move || {
        std::fs::write(
            &gitfile_for_hook,
            format!("gitdir: {}\n", decoy_gitdir.display()),
        )
        .unwrap();
    });

    let result = reset_branch(
        linked.path(),
        Some("feature"),
        Some(&source),
        &target,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    );
    std::fs::write(&gitfile, original).unwrap();
    result.expect("the reset runs in the scope the lease validated");
    assert_eq!(
        std::fs::read_to_string(linked.0.join("f.txt")).unwrap(),
        "one\n",
        "the leased worktree must be the one that was reset"
    );
    assert_eq!(
        std::fs::read_to_string(decoy.0.join("f.txt")).unwrap(),
        "decoy\n",
        "the retargeted repository must be untouched"
    );
}

#[test]
fn hard_reset_rejects_linked_worktree_scope_retarget() {
    let main = TempRepo::new("hard-reset-linked-main");
    main.git_ok(&["init", "-q", "-b", "main"]);
    main.git_ok(&["config", "user.email", "t@t.t"]);
    main.git_ok(&["config", "user.name", "T"]);
    main.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(main.0.join("f.txt"), b"one\n").unwrap();
    main.git_ok(&["add", "f.txt"]);
    main.git_ok(&["commit", "-qm", "one"]);
    std::fs::write(main.0.join("f.txt"), b"two\n").unwrap();
    main.git_ok(&["commit", "-qam", "two"]);
    main.git_ok(&["branch", "feature"]);
    let linked = TempRepo::new("hard-reset-linked-wt");
    std::fs::remove_dir_all(&linked.0).unwrap();
    main.git_ok(&["worktree", "add", "-q", linked.path(), "feature"]);
    std::fs::write(linked.0.join("f.txt"), b"dirty\n").unwrap();

    let target = rev_parse(&main, "main~1");
    let source = rev_parse(&linked, "HEAD");
    let preview = preview_reset(linked.path(), &target, "hard", "HEAD").expect("preview");
    let decoy = TempRepo::new("hard-reset-linked-decoy");
    decoy.git_ok(&["init", "-q", "-b", "main"]);
    decoy.git_ok(&["config", "user.email", "t@t.t"]);
    decoy.git_ok(&["config", "user.name", "T"]);
    decoy.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(decoy.0.join("f.txt"), b"decoy\n").unwrap();
    decoy.git_ok(&["add", "f.txt"]);
    decoy.git_ok(&["commit", "-qm", "decoy"]);
    let gitfile = linked.0.join(".git");
    let original = std::fs::read(&gitfile).unwrap();
    let decoy_gitdir = decoy.0.join(".git").canonicalize().unwrap();
    let gitfile_for_hook = gitfile.clone();
    // Retarget after tip preparation so the mutation-boundary lease check is
    // what rejects the replaced repository scope.
    set_hard_reset_before_mutation_test_hook(move || {
        std::fs::write(
            &gitfile_for_hook,
            format!("gitdir: {}\n", decoy_gitdir.display()),
        )
        .unwrap();
    });

    let result = reset_branch(
        linked.path(),
        Some("feature"),
        Some(&source),
        &target,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    );
    std::fs::write(&gitfile, original).unwrap();
    let error = result.expect_err("retargeted gitfile must invalidate the lease");
    // The retarget breaks the re-capture itself rather than producing a
    // mismatch, so this is the "could not verify" wording, not the stale one.
    assert!(
        error.contains("was not performed"),
        "unexpected error: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(linked.0.join("f.txt")).unwrap(),
        "dirty\n"
    );
    main.git_ok(&["worktree", "remove", "--force", linked.path()]);
}

#[test]
fn hard_reset_rejects_non_current_source_without_switching() {
    let (repo, base) = repo_with_base_commit("hard-reset-no-switch");
    repo.git_ok(&["branch", "other"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "advance"]);
    let other_tip = rev_parse(&repo, "other");
    let active = String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout)
        .trim()
        .to_string();
    assert_eq!(active, "main");

    // Preview while on `other` so the lease matches that worktree, then switch
    // away before execute — hard reset must refuse rather than `git switch`.
    repo.git_ok(&["checkout", "-q", "other"]);
    let preview = preview_reset(repo.path(), &base, "hard", "other").expect("preview");
    repo.git_ok(&["checkout", "-q", "main"]);
    let main_before = rev_parse(&repo, "main");
    let dirty = repo.0.join("keep.txt");
    std::fs::write(&dirty, b"precious\n").unwrap();

    let error = reset_branch(
        repo.path(),
        Some("other"),
        Some(&other_tip),
        &base,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("hard reset must not switch branches to reach the source");
    assert!(
        error.contains("already be checked out"),
        "unexpected error: {error}"
    );
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout).trim(),
        "main",
        "failed hard reset must leave HEAD on the original branch"
    );
    assert_eq!(rev_parse(&repo, "main"), main_before);
    assert_eq!(rev_parse(&repo, "other"), other_tip);
    assert_eq!(std::fs::read_to_string(&dirty).unwrap(), "precious\n");
}

#[test]
fn hard_reset_preview_rejects_non_current_source() {
    let (repo, base) = repo_with_base_commit("hard-reset-preview-no-switch");
    repo.git_ok(&["branch", "other"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "advance"]);
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout).trim(),
        "main"
    );

    let error = preview_reset(repo.path(), &base, "hard", "other")
        .expect_err("hard preview must refuse a non-current source");
    assert!(
        error.contains("already be checked out"),
        "unexpected error: {error}"
    );
    // Soft/mixed may still preview a non-current source (execute checks it out).
    preview_reset(repo.path(), &base, "mixed", "other").expect("mixed preview of other");
}

#[test]
fn hard_reset_rejects_close_reopen_worktree_aba() {
    let main = TempRepo::new("hard-reset-close-reopen-main");
    main.git_ok(&["init", "-q", "-b", "main"]);
    main.git_ok(&["config", "user.email", "t@t.t"]);
    main.git_ok(&["config", "user.name", "T"]);
    main.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(main.0.join("f.txt"), b"one\n").unwrap();
    main.git_ok(&["add", "f.txt"]);
    main.git_ok(&["commit", "-qm", "one"]);
    std::fs::write(main.0.join("f.txt"), b"two\n").unwrap();
    main.git_ok(&["commit", "-qam", "two"]);
    main.git_ok(&["branch", "feature"]);

    let linked = TempRepo::new("hard-reset-close-reopen-wt");
    std::fs::remove_dir_all(&linked.0).unwrap();
    main.git_ok(&["worktree", "add", "-q", linked.path(), "feature"]);
    std::fs::write(linked.0.join("f.txt"), b"dirty\n").unwrap();

    let target = rev_parse(&main, "main~1");
    let source = rev_parse(&linked, "HEAD");
    let preview = preview_reset(linked.path(), &target, "hard", "HEAD").expect("preview");

    // Remove and recreate the worktree at the same path — content and tip match,
    // but directory identities (inodes) differ, so the lease must fail closed.
    main.git_ok(&["worktree", "remove", "--force", linked.path()]);
    main.git_ok(&["worktree", "add", "-q", linked.path(), "feature"]);
    std::fs::write(linked.0.join("f.txt"), b"dirty\n").unwrap();

    let error = reset_branch(
        linked.path(),
        Some("feature"),
        Some(&source),
        &target,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("recreated worktree must invalidate scoped identities");
    assert!(
        error.contains("changed after this confirmation"),
        "unexpected error: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(linked.0.join("f.txt")).unwrap(),
        "dirty\n"
    );
    main.git_ok(&["worktree", "remove", "--force", linked.path()]);
}

#[test]
fn hard_reset_rejects_unstable_capture_aba() {
    let repo = TempRepo::new("hard-reset-unstable");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["commit", "-qam", "two"]);
    let target = rev_parse(&repo, "HEAD~1");
    let dirty = repo.0.join("f.txt");
    set_hard_reset_capture_test_hook(move || {
        std::fs::write(&dirty, b"mid-capture\n").unwrap();
    });
    let error = preview_reset(repo.path(), &target, "hard", "HEAD")
        .expect_err("mid-capture drift must fail closed");
    assert!(error.contains("changed while"), "unexpected error: {error}");
}

#[test]
fn hard_reset_uses_previewed_target_oid_not_moved_symbolic_name() {
    let repo = TempRepo::new("hard-reset-target-oid");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    let first = rev_parse(&repo, "HEAD");
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["commit", "-qam", "two"]);
    let second = rev_parse(&repo, "HEAD");
    repo.git_ok(&["branch", "target-ref", &first]);
    let preview = preview_reset(repo.path(), "target-ref", "hard", "HEAD").expect("preview");
    assert_eq!(preview.target_oid, first);

    // Move the symbolic name after preview; execute must still land on the leased oid.
    repo.git_ok(&["branch", "-f", "target-ref", &second]);
    reset_branch(
        repo.path(),
        Some("main"),
        preview.expected_source_oid.as_deref(),
        &preview.target_oid,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect("reset to leased oid");
    assert_eq!(rev_parse(&repo, "HEAD"), first);
}

#[test]
fn hard_reset_does_not_qualify_the_leased_oid_into_a_same_named_branch() {
    // Git permits a branch and a tag literally named after a 40-hex oid. A bare
    // oid still resolves to the object, but qualifying it to refs/heads/<oid>
    // would resolve to that branch's movable tip — so the leased oid must reach
    // `git reset --hard` unqualified.
    let repo = TempRepo::new("hard-reset-hex-named-ref");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    let first = rev_parse(&repo, "HEAD");
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["commit", "-qam", "two"]);
    let second = rev_parse(&repo, "HEAD");

    let preview = preview_reset(repo.path(), "HEAD~1", "hard", "HEAD").expect("preview");
    assert_eq!(preview.target_oid, first);

    // After the preview, plant the ambiguous pair pointing away from the target.
    repo.git_ok(&["branch", &first, &second]);
    repo.git_ok(&["tag", &first, &second]);

    reset_branch(
        repo.path(),
        Some("main"),
        preview.expected_source_oid.as_deref(),
        &preview.target_oid,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect("reset to leased oid");
    assert_eq!(
        rev_parse(&repo, "HEAD"),
        first,
        "reset must land on the leased oid, not refs/heads/<oid>"
    );
}

#[test]
fn mixed_reset_does_not_qualify_the_previewed_oid_into_a_same_named_branch() {
    // Soft/mixed carry the same previewed oid as hard, so they take the same
    // unqualified path — a branch named after the oid must not capture them.
    let repo = TempRepo::new("mixed-reset-hex-named-ref");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "one"]);
    let first = rev_parse(&repo, "HEAD");
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "two"]);
    let second = rev_parse(&repo, "HEAD");
    repo.git_ok(&["branch", &first, &second]);
    repo.git_ok(&["tag", &first, &second]);

    reset_branch(
        repo.path(),
        Some("main"),
        Some(&second),
        &first,
        "mixed",
        None,
        None,
        None,
    )
    .expect("reset to the previewed oid");
    assert_eq!(
        rev_parse(&repo, "HEAD"),
        first,
        "reset must land on the previewed oid, not refs/heads/<oid>"
    );
}

#[test]
fn reset_rejects_a_target_that_is_not_an_exact_oid() {
    // Soft/mixed carry no lease, so the write boundary is the only thing
    // standing between a ref name and `git reset` — hard mode additionally
    // expires its token, which binds the target string the preview resolved.
    let repo = TempRepo::new("reset-inexact-target");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    let first = rev_parse(&repo, "HEAD");
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["commit", "-qam", "two"]);
    let second = rev_parse(&repo, "HEAD");
    repo.git_ok(&["branch", "target-ref", &first]);

    let preview = preview_reset(repo.path(), "target-ref", "mixed", "HEAD").expect("preview");
    assert_eq!(preview.target_oid, first);

    // Hand the write the NAME the preview resolved, not the oid it returned.
    let error = reset_branch(
        repo.path(),
        Some("main"),
        preview.expected_source_oid.as_deref(),
        "target-ref",
        "mixed",
        None,
        None,
        None,
    )
    .expect_err("a ref name must not reach git reset");
    assert!(
        error.contains("exact commit id"),
        "unexpected error: {error}"
    );
    assert_eq!(
        rev_parse(&repo, "HEAD"),
        second,
        "the reset must be refused before any mutation"
    );
}

#[test]
fn hard_reset_leases_an_ignored_file_colliding_by_case_with_the_target() {
    // On a case-insensitive checkout an ignored FOO.txt and the target's
    // foo.txt are one filesystem entry, so the reset overwrites the ignored
    // file. Status omits ignored paths, so only obstruction detection can lease
    // it — and byte-exact matching missed the collision. `core.ignorecase` is
    // set explicitly so the test is deterministic on case-sensitive CI too.
    let repo = TempRepo::new("hard-reset-case-collision");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    repo.git_ok(&["config", "core.ignorecase", "true"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "base"]);
    std::fs::write(repo.0.join("foo.txt"), b"tracked\n").unwrap();
    repo.git_ok(&["add", "foo.txt"]);
    repo.git_ok(&["commit", "-qm", "adds foo"]);
    let target = rev_parse(&repo, "HEAD");
    repo.git_ok(&["rm", "-q", "foo.txt"]);
    repo.git_ok(&["commit", "-qm", "removes foo"]);
    std::fs::write(repo.0.join(".gitignore"), b"FOO.txt\n").unwrap();
    repo.git_ok(&["add", ".gitignore"]);
    repo.git_ok(&["commit", "-qm", "ignores FOO"]);
    // Ignored, so `git status` never reports it — the lease must pick it up as
    // an obstruction or not at all.
    std::fs::write(repo.0.join("FOO.txt"), b"ignored\n").unwrap();

    let preview = preview_reset(repo.path(), &target, "hard", "HEAD").expect("preview");
    std::fs::write(repo.0.join("FOO.txt"), b"edited after preview\n").unwrap();

    let error = reset_branch(
        repo.path(),
        Some("main"),
        preview.expected_source_oid.as_deref(),
        &preview.target_oid,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("editing the case-colliding obstruction must expire the lease");
    assert!(
        error.contains("changed after this confirmation"),
        "unexpected error: {error}"
    );
}

#[test]
fn hard_reset_rejects_drift_injected_before_mutation() {
    let repo = TempRepo::new("hard-reset-pre-mutation");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["commit", "-qam", "two"]);
    let target = rev_parse(&repo, "HEAD~1");
    let source = rev_parse(&repo, "HEAD");
    let preview = preview_reset(repo.path(), &target, "hard", "HEAD").expect("preview");
    let dirty = repo.0.join("f.txt");
    // Inject after tip/HEAD preparation and immediately before the final lease
    // re-capture that sits next to `git reset --hard`.
    set_hard_reset_before_mutation_test_hook(move || {
        std::fs::write(&dirty, b"late\n").unwrap();
    });
    let error = reset_branch(
        repo.path(),
        Some("main"),
        Some(&source),
        &target,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("pre-mutation drift must abort");
    assert!(
        error.contains("changed after this confirmation"),
        "unexpected error: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("f.txt")).unwrap(),
        "late\n"
    );
}

#[test]
fn hard_reset_rejects_ignored_target_obstruction_drift() {
    let repo = TempRepo::new("hard-reset-ignored-obstruction");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("tracked.txt"), b"one\n").unwrap();
    std::fs::write(repo.0.join("restored.txt"), b"target\n").unwrap();
    repo.git_ok(&["add", "tracked.txt", "restored.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    repo.git_ok(&["rm", "-q", "restored.txt"]);
    repo.git_ok(&["commit", "-am", "two"]);
    std::fs::write(repo.0.join(".git/info/exclude"), b"restored.txt\n").unwrap();
    std::fs::write(repo.0.join("restored.txt"), b"obstruct\n").unwrap();
    let target = rev_parse(&repo, "HEAD~1");
    let source = rev_parse(&repo, "HEAD");
    let preview = preview_reset(repo.path(), &target, "hard", "HEAD").expect("preview");
    assert!(
        preview.expected_state.is_some(),
        "hard preview must lease the ignored obstruction"
    );

    std::fs::write(repo.0.join("restored.txt"), b"changed after confirm\n").unwrap();
    let error = reset_branch(
        repo.path(),
        Some("main"),
        Some(&source),
        &target,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("ignored obstruction drift must expire the lease");
    assert!(
        error.contains("changed after this confirmation"),
        "unexpected error: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("restored.txt")).unwrap(),
        "changed after confirm\n"
    );
}

#[test]
fn hard_reset_preview_rejects_active_replace_refs() {
    let repo = TempRepo::new("hard-reset-replace-refs");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["commit", "-qam", "two"]);
    let first = rev_parse(&repo, "HEAD~1");
    let second = rev_parse(&repo, "HEAD");
    repo.git_ok(&["replace", &second, &first]);

    let error = preview_reset(repo.path(), &first, "hard", "HEAD")
        .expect_err("active replacement refs must fail closed");
    assert!(
        error.contains("replacement refs"),
        "unexpected error: {error}"
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
    let result = continue_operation(repo.path(), "merge", Some("T"), Some("t@t.t"), None, false);
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
fn skip_operation_replays_the_next_commit_with_the_captured_identity() {
    let (repo, _) = repo_with_base_commit("skip-pins-identity");
    set_repo_identity(
        repo.path(),
        "Selected Card",
        "selected@example.test",
        Some(""),
        Some(""),
        Some(false),
        Some(false),
    )
    .expect("set selected identity");
    let captured = repo_identity(repo.path())
        .expect("read selected identity")
        .expect("selected identity exists");

    repo.git_ok(&["checkout", "-q", "-b", "source"]);
    std::fs::write(repo.0.join("f.txt"), "source conflict\n").unwrap();
    repo.git_ok(&["commit", "-q", "-a", "-m", "conflicting source"]);
    let conflicting = rev_parse(&repo, "HEAD");
    std::fs::write(repo.0.join("after.txt"), "replayed after skip\n").unwrap();
    repo.git_ok(&["add", "after.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "replay me"]);
    let replayed = rev_parse(&repo, "HEAD");

    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("f.txt"), "destination conflict\n").unwrap();
    repo.git_ok(&["commit", "-q", "-a", "-m", "destination"]);
    let destination = rev_parse(&repo, "HEAD");

    repo.git_ok(&["config", "extensions.worktreeConfig", "true"]);
    repo.git_ok(&["config", "--worktree", "user.name", "Worktree Override"]);
    repo.git_ok(&[
        "config",
        "--worktree",
        "user.email",
        "override@example.test",
    ]);
    repo.git_ok(&["config", "--worktree", "gpg.format", "ssh"]);
    repo.git_ok(&[
        "config",
        "--worktree",
        "user.signingkey",
        "/missing/skip-signing-key.pub",
    ]);
    repo.git_ok(&["config", "--worktree", "commit.gpgsign", "true"]);

    let start = cherry_pick_many_onto(
        repo.path(),
        Some("main"),
        &destination,
        &[conflicting, replayed],
    );
    assert!(start.is_err(), "first replay must stop on the conflict");

    skip_operation(
        repo.path(),
        "cherry-pick",
        Some("Selected Card"),
        Some("selected@example.test"),
        Some(&captured),
        true,
    )
    .expect("skip should replay the next commit with captured config");
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["show", "-s", "--format=%an|%ae", "HEAD"]).stdout,)
            .trim(),
        "Selected Card|selected@example.test"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("after.txt")).unwrap(),
        "replayed after skip\n"
    );
}

#[cfg(unix)]
#[test]
fn resolve_conflict_file_refuses_a_final_symlink_and_preserves_its_target() {
    use std::os::unix::fs::symlink;

    let repo = merge_conflict_repo("resolve-final-symlink");
    let outside = repo.0.with_extension("outside-target");
    let _ = std::fs::remove_file(&outside);
    std::fs::write(&outside, "outside must survive\n").unwrap();
    std::fs::remove_file(repo.0.join("f.txt")).unwrap();
    symlink(&outside, repo.0.join("f.txt")).unwrap();

    let result = resolve_conflict_file(repo.path(), "f.txt", "attacker content\n");

    assert!(result.is_err(), "final symlink must be refused: {result:?}");
    assert_eq!(
        std::fs::read_to_string(&outside).unwrap(),
        "outside must survive\n"
    );
    let unmerged = repo.git(&["ls-files", "-u", "--", "f.txt"]);
    assert!(
        !String::from_utf8_lossy(&unmerged.stdout).trim().is_empty(),
        "a refused write must not stage the conflict"
    );

    let _ = std::fs::remove_file(&outside);
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
    assert!(skip_operation("/tmp", "merge", None, None, None, false).is_err());
    assert!(skip_operation("/tmp", "nonsense", None, None, None, false).is_err());
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

#[cfg(not(windows))]
#[test]
fn resolving_a_pathspec_magic_filename_leaves_other_conflicts_unmerged() {
    let repo = TempRepo::new("literal-conflict-path");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    let magic = ":(glob)*";
    std::fs::write(repo.0.join(magic), "base\n").unwrap();
    std::fs::write(repo.0.join("victim.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "-A"]);
    repo.git_ok(&["commit", "-q", "-m", "base"]);
    repo.git_ok(&["checkout", "-q", "-b", "other"]);
    std::fs::write(repo.0.join(magic), "theirs\n").unwrap();
    std::fs::write(repo.0.join("victim.txt"), "theirs\n").unwrap();
    repo.git_ok(&["commit", "-qam", "theirs"]);
    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join(magic), "ours\n").unwrap();
    std::fs::write(repo.0.join("victim.txt"), "ours\n").unwrap();
    repo.git_ok(&["commit", "-qam", "ours"]);
    let merge = repo.git(&["merge", "other"]);
    assert!(
        !merge.status.success(),
        "merge should stop on both conflicts"
    );

    mark_conflict_resolved(repo.path(), magic).expect("stage only the literal conflict path");

    let unmerged = repo.git(&["ls-files", "-u"]);
    let unmerged = String::from_utf8_lossy(&unmerged.stdout);
    assert!(
        !unmerged.contains(magic),
        "magic filename should be resolved: {unmerged}"
    );
    assert!(
        unmerged.contains("victim.txt"),
        "unrelated conflict must remain unresolved: {unmerged}"
    );
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

/// Restores a directory's mode on drop so a test that makes one unwritable
/// cannot leave `TempRepo`'s recursive delete unable to clean up.
#[cfg(unix)]
struct RestoredMode(PathBuf, u32);

#[cfg(unix)]
impl RestoredMode {
    fn clamp(path: PathBuf, mode: u32) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let original = std::fs::metadata(&path).unwrap().permissions().mode();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        Self(path, original)
    }
}

#[cfg(unix)]
impl Drop for RestoredMode {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(self.1));
    }
}

#[test]
#[cfg(unix)]
fn stash_finishes_the_restore_git_abandons_on_an_unremovable_directory() {
    // `git stash push --include-untracked` stores the entry, then clears the
    // working tree with a blanket `git clean -fd` *before* `reset --hard`. A
    // directory it cannot remove aborts the push between those two steps, so
    // git exits non-zero having saved everything and restored nothing. GitLane
    // used to surface that raw warning as a plain failure while the stash sat
    // in the list and the tracked edits stayed on disk.
    let repo = stash_seed_repo("stash-unremovable-dir");

    std::fs::write(repo.0.join("f.txt"), b"edited\n").unwrap();
    std::fs::create_dir_all(repo.0.join("trunk/web")).unwrap();
    std::fs::write(repo.0.join("trunk/web/u.txt"), b"untracked\n").unwrap();
    // Read-only parent: git can delete `trunk/web/u.txt` but not `trunk/web`.
    let _mode = RestoredMode::clamp(repo.0.join("trunk"), 0o555);

    let message = stash(repo.path()).expect("an interrupted cleanup still stashes");

    assert!(
        message.contains("Permission denied"),
        "the outcome must name what Git could not remove: {message}"
    );
    let status = repo.git(&["status", "--porcelain"]);
    assert!(
        String::from_utf8_lossy(&status.stdout).trim().is_empty(),
        "the working tree must end up cleared, not split: {}",
        String::from_utf8_lossy(&status.stdout)
    );
    assert!(
        repo.0.join("trunk/web").is_dir(),
        "the directory Git could not remove stays on disk"
    );

    // Everything the push captured must still round-trip out of the entry.
    let oid = stash_list(repo.path()).expect("list")[0].oid.clone();
    stash_apply(repo.path(), &oid).expect("restore the stashed changes");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("f.txt")).unwrap(),
        "edited\n"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("trunk/web/u.txt")).unwrap(),
        "untracked\n"
    );
}

#[test]
fn stash_still_reports_a_push_that_stored_no_entry() {
    // Recovery is gated on `refs/stash` having moved. A push that never got as
    // far as storing an entry — no commit to stash onto — must stay a failure
    // rather than being reported as a completed stash.
    let repo = TempRepo::new("stash-unborn");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    std::fs::write(repo.0.join("new.txt"), b"new\n").unwrap();

    let error = stash(repo.path()).expect_err("an unborn HEAD cannot be stashed");

    assert!(
        error.contains("initial commit"),
        "git's own diagnosis should survive: {error}"
    );
    assert!(
        stash_list(repo.path()).expect("list").is_empty(),
        "no stash entry should exist"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("new.txt")).unwrap(),
        "new\n",
        "a failed push must not touch the working tree"
    );
}

#[test]
fn stash_preserves_empty_untracked_directories() {
    // `git stash push -u` clears captured untracked files with a blanket
    // `git clean -fd`, and `-d` takes empty directories with it. They never
    // appear in `git status` and a stash commit records only blobs, so the
    // deletion is silent and unrecoverable — GL-218's collateral deletion,
    // still live for stash. Every directory here is one git 2.55 was observed
    // to remove.
    let repo = stash_seed_repo("stash-empty-dirs");
    repo.git_ok(&["config", "core.excludesFile", "/dev/null"]);
    std::fs::write(repo.0.join(".gitignore"), b"ignored-dir/\n*.log\n").unwrap();
    repo.git_ok(&["add", ".gitignore"]);
    repo.git_ok(&["commit", "-qm", "ignores"]);

    std::fs::create_dir_all(repo.0.join("plain-empty")).unwrap();
    std::fs::create_dir_all(repo.0.join("nested-empty/a/b")).unwrap();
    // A file-free subtree beside an untracked file: applying the stash puts
    // `mixed/m.txt` back and so recreates `mixed/`, but never `mixed/deep`.
    std::fs::create_dir_all(repo.0.join("mixed/deep")).unwrap();
    std::fs::write(repo.0.join("mixed/m.txt"), b"untracked\n").unwrap();
    // Untouched by `clean` without `-x`; must survive without being clobbered.
    std::fs::create_dir_all(repo.0.join("ignored-dir")).unwrap();
    std::fs::create_dir_all(repo.0.join("only-ignored")).unwrap();
    std::fs::write(repo.0.join("only-ignored/x.log"), b"ignored\n").unwrap();
    std::fs::write(repo.0.join("f.txt"), b"edited\n").unwrap();

    let message = stash(repo.path()).expect("stash the edit");

    assert_eq!(
        message, "Stashed your changes.",
        "preserving directories is not something to report: {message}"
    );
    for kept in [
        "plain-empty",
        "nested-empty",
        "nested-empty/a",
        "nested-empty/a/b",
        "mixed/deep",
        "ignored-dir",
        "only-ignored",
    ] {
        assert!(
            repo.0.join(kept).is_dir(),
            "{kept} must survive the stash — no stash can restore an empty directory"
        );
    }
    assert_eq!(
        std::fs::read_to_string(repo.0.join("only-ignored/x.log")).unwrap(),
        "ignored\n",
        "an ignored file must not be disturbed"
    );
    // The stash itself is unaffected: untracked files still go in and come back.
    let status = repo.git(&["status", "--porcelain"]);
    assert!(
        String::from_utf8_lossy(&status.stdout).trim().is_empty(),
        "the working tree is still cleared: {}",
        String::from_utf8_lossy(&status.stdout)
    );
    let oid = stash_list(repo.path()).expect("list")[0].oid.clone();
    stash_apply(repo.path(), &oid).expect("restore the stash");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("mixed/m.txt")).unwrap(),
        "untracked\n"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("f.txt")).unwrap(),
        "edited\n"
    );
}

#[test]
fn stash_still_handles_a_staged_deletion_alongside_an_empty_directory() {
    // This is why preservation restores rather than prevents. Scoping git's
    // cleanup by driving the push with an explicit pathspec would also spare
    // empty directories, but git's pathspec mode runs a bare `git add --
    // <paths>` that dies with "pathspec did not match any files" on a staged
    // deletion — the path is in neither the index nor the worktree — after the
    // entry is already stored. Both must work at once.
    let repo = stash_seed_repo("stash-staged-deletion");
    std::fs::write(repo.0.join("doomed.txt"), b"doomed\n").unwrap();
    repo.git_ok(&["add", "doomed.txt"]);
    repo.git_ok(&["commit", "-qm", "add doomed"]);
    repo.git_ok(&["rm", "-q", "doomed.txt"]);
    std::fs::create_dir_all(repo.0.join("empty")).unwrap();
    std::fs::write(repo.0.join("f.txt"), b"edited\n").unwrap();

    stash(repo.path()).expect("a staged deletion stashes alongside an empty dir");

    let status = repo.git(&["status", "--porcelain"]);
    assert!(
        String::from_utf8_lossy(&status.stdout).trim().is_empty(),
        "the staged deletion must be stashed, not left behind: {}",
        String::from_utf8_lossy(&status.stdout)
    );
    assert!(repo.0.join("doomed.txt").is_file(), "the file is restored");
    assert!(
        repo.0.join("empty").is_dir(),
        "the empty directory survives"
    );

    let oid = stash_list(repo.path()).expect("list")[0].oid.clone();
    stash_apply(repo.path(), &oid).expect("restore the stash");
    assert!(
        !repo.0.join("doomed.txt").exists(),
        "applying the stash reinstates the deletion"
    );
}

#[test]
fn stash_does_not_walk_into_a_nested_repository() {
    // Git's cleanup skips a nested repository ("Ignoring path foo/"), so it is
    // neither at risk nor ours to walk — and an empty directory inside one
    // belongs to that repository, not this worktree.
    let repo = stash_seed_repo("stash-empty-dirs-nested");
    let nested = repo.0.join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    let init = Command::new("git")
        .args(["init", "-q", nested.to_str().unwrap()])
        .output()
        .expect("git init launches");
    assert!(init.status.success(), "nested git init failed");
    std::fs::create_dir_all(nested.join("its-own-empty")).unwrap();
    std::fs::write(repo.0.join("f.txt"), b"edited\n").unwrap();

    stash(repo.path()).expect("stash the edit");

    assert!(nested.join(".git").exists(), "the nested repo survives");
    assert!(
        nested.join("its-own-empty").is_dir(),
        "a directory inside a skipped nested repo is untouched either way"
    );
}

#[test]
#[cfg(unix)]
fn stash_restores_the_mode_of_a_preserved_directory() {
    // Recreating the directory is only half of putting it back; a mode the user
    // set on purpose has to come with it.
    use std::os::unix::fs::PermissionsExt;
    let repo = stash_seed_repo("stash-empty-dir-mode");
    let guarded = repo.0.join("guarded");
    std::fs::create_dir_all(&guarded).unwrap();
    std::fs::set_permissions(&guarded, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(repo.0.join("f.txt"), b"edited\n").unwrap();

    stash(repo.path()).expect("stash the edit");

    let mode = std::fs::metadata(&guarded).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o700, "the directory's mode is restored too");
}

#[test]
fn stash_normalizes_a_routine_success_but_not_an_empty_one() {
    // The outcome is toasted, and git's success line is a paragraph naming the
    // branch and the subject it stashed onto — noise beside the stash row that
    // just appeared. A routine stash reports its own short line instead; a push
    // that stashed nothing must still say so in git's words.
    let repo = stash_seed_repo("stash-normalized-message");

    std::fs::write(repo.0.join("f.txt"), b"edited\n").unwrap();
    let message = stash(repo.path()).expect("stash the edit");
    assert_eq!(message, "Stashed your changes.");
    assert!(
        !message.contains("Saved working directory"),
        "git's verbose success line must not reach the toast: {message}"
    );

    // Nothing left to stash: git's own wording, not a claimed stash.
    let empty = stash(repo.path()).expect("a clean tree is not an error");
    assert!(
        empty.contains("No local changes"),
        "an empty stash must not be reported as a fresh one: {empty}"
    );
    assert_eq!(
        stash_list(repo.path()).expect("list").len(),
        1,
        "only the first push stored an entry"
    );
}

#[test]
fn stash_failure_does_not_adopt_an_unrelated_standing_stash() {
    // Recovery may fall back to the standing `refs/stash` tip, because a push
    // that re-creates an identical stash commit leaves the ref unmoved. That
    // fallback must not turn an ordinary failure into a reported stash: with a
    // locked index nothing is stored, the existing entry does not cover the
    // working tree, and git's own diagnosis has to survive intact.
    let repo = stash_seed_repo("stash-standing-tip");

    std::fs::write(repo.0.join("f.txt"), b"stashed\n").unwrap();
    repo.git_ok(&["stash", "push", "-q"]);
    let standing = stash_list(repo.path()).expect("list")[0].oid.clone();

    std::fs::write(repo.0.join("f.txt"), b"different\n").unwrap();
    std::fs::write(repo.0.join(".git/index.lock"), b"").unwrap();

    let error = stash(repo.path()).expect_err("a locked index cannot be stashed");

    assert!(
        error.contains("index.lock") || error.contains("could not write index"),
        "git's own diagnosis should survive: {error}"
    );
    assert!(
        !error.contains("saved to stash"),
        "a push that stored nothing must not be reported as a split state: {error}"
    );
    let entries = stash_list(repo.path()).expect("list");
    assert_eq!(entries.len(), 1, "no entry should have been added");
    assert_eq!(entries[0].oid, standing, "the standing entry is untouched");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("f.txt")).unwrap(),
        "different\n",
        "the working tree must not be reset onto an unrelated stash"
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

fn discard_current(
    repo: &TempRepo,
    file: &str,
    previous_file: Option<&str>,
    staged: bool,
) -> Result<String, String> {
    let preview = preview_discard_file(repo.path(), file, previous_file, staged)?;
    discard_file(
        repo.path(),
        file,
        previous_file,
        staged,
        &preview.expected_state,
    )
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
fn discard_preview_rejects_a_stale_source_bucket() {
    // The preview is now the source-of-truth boundary: a staged-only file must
    // not be accepted as an unstaged target. The former stale-flag fallback made
    // this case indistinguishable from a staged-new file with additional
    // worktree edits, whose staged blob must be preserved.
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

    let error = preview_discard_file(repo.path(), "staged_new.txt", None, false)
        .expect_err("a staged-only file has no unstaged discard target");
    assert!(error.contains("unstaged"), "unexpected error: {error}");
    assert_eq!(index_entries(&repo), ["staged_new.txt"]);
    assert!(repo.0.join("staged_new.txt").exists());

    discard_current(&repo, "staged_new.txt", None, true).expect("discard staged-new file");
    assert!(
        index_entries(&repo).is_empty(),
        "staged-new file leaves the index"
    );
    assert!(
        !repo.0.join("staged_new.txt").exists(),
        "staged-new file leaves the worktree"
    );

    // The genuinely untracked path still goes through `git clean`.
    discard_current(&repo, "untracked.txt", None, false).expect("discard untracked file");
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

    discard_current(&repo, "untracked/file.txt", None, false).expect("discard untracked file");

    assert!(!repo.0.join("untracked/file.txt").exists());
    assert!(repo.0.join("untracked/empty-nested").is_dir());
}

#[test]
fn discard_file_restores_both_sides_of_unstaged_and_staged_renames() {
    for staged in [false, true] {
        let repo = repo_with_file(
            if staged {
                "discard-staged-rename"
            } else {
                "discard-unstaged-rename"
            },
            "old.txt",
            b"original\n",
        );
        if staged {
            repo.git_ok(&["mv", "old.txt", "new.txt"]);
        } else {
            std::fs::rename(repo.0.join("old.txt"), repo.0.join("new.txt")).unwrap();
        }

        discard_current(&repo, "new.txt", Some("old.txt"), staged)
            .expect("discard both rename sides");

        assert_eq!(
            std::fs::read(repo.0.join("old.txt")).unwrap(),
            b"original\n"
        );
        assert!(!repo.0.join("new.txt").exists());
        assert!(
            String::from_utf8_lossy(&repo.git(&["status", "--porcelain"]).stdout)
                .trim()
                .is_empty()
        );
    }
}

#[test]
fn discard_file_preserves_staged_content_when_discarding_an_unstaged_rename() {
    let repo = repo_with_file("discard-partially-staged-rename", "old.txt", b"original\n");
    std::fs::write(repo.0.join("old.txt"), b"staged edit\n").unwrap();
    repo.git_ok(&["add", "old.txt"]);
    std::fs::rename(repo.0.join("old.txt"), repo.0.join("new.txt")).unwrap();

    discard_current(&repo, "new.txt", Some("old.txt"), false)
        .expect("discard only the worktree rename");

    assert_eq!(
        std::fs::read(repo.0.join("old.txt")).unwrap(),
        b"staged edit\n"
    );
    assert!(!repo.0.join("new.txt").exists());
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["show", ":old.txt"]).stdout),
        "staged edit\n"
    );
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["status", "--porcelain=v1"]).stdout),
        "M  old.txt\n"
    );
}

#[test]
fn discard_file_handles_a_case_only_staged_rename() {
    let repo = repo_with_file("discard-case-only-rename", "case.txt", b"original\n");
    repo.git_ok(&["mv", "case.txt", "case-intermediate.txt"]);
    repo.git_ok(&["mv", "case-intermediate.txt", "CASE.txt"]);

    discard_current(&repo, "CASE.txt", Some("case.txt"), true)
        .expect("discard the case-only rename");

    assert_eq!(
        std::fs::read(repo.0.join("case.txt")).unwrap(),
        b"original\n"
    );
    let worktree_names: Vec<_> = std::fs::read_dir(&repo.0)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name())
        .collect();
    assert!(worktree_names.iter().any(|name| name == "case.txt"));
    assert!(!worktree_names.iter().any(|name| name == "CASE.txt"));
    assert!(
        String::from_utf8_lossy(&repo.git(&["status", "--porcelain=v1"]).stdout)
            .trim()
            .is_empty()
    );
}

#[test]
fn discard_file_refuses_a_stale_rename_pair_before_mutating_either_path() {
    for staged in [false, true] {
        let repo = repo_with_file(
            if staged {
                "discard-stale-staged-rename"
            } else {
                "discard-stale-unstaged-rename"
            },
            "old.txt",
            b"old base\n",
        );
        std::fs::write(repo.0.join("new.txt"), b"new base\n").unwrap();
        repo.git_ok(&["add", "new.txt"]);
        repo.git_ok(&["commit", "-q", "-m", "track both paths"]);
        std::fs::write(repo.0.join("old.txt"), b"precious old edit\n").unwrap();
        std::fs::write(repo.0.join("new.txt"), b"precious new edit\n").unwrap();
        if staged {
            repo.git_ok(&["add", "old.txt", "new.txt"]);
        }
        let before_status = repo.git(&["status", "--porcelain=v1", "-z"]);
        let before_index = repo.git(&["diff", "--cached", "--binary"]);

        let error = preview_discard_file(repo.path(), "new.txt", Some("old.txt"), staged)
            .expect_err("stale rename metadata must fail closed");

        assert!(
            error.contains("changed") || error.contains("no longer available"),
            "unexpected error: {error}"
        );
        assert_eq!(
            std::fs::read(repo.0.join("old.txt")).unwrap(),
            b"precious old edit\n"
        );
        assert_eq!(
            std::fs::read(repo.0.join("new.txt")).unwrap(),
            b"precious new edit\n"
        );
        let after_status = repo.git(&["status", "--porcelain=v1", "-z"]);
        let after_index = repo.git(&["diff", "--cached", "--binary"]);
        assert_eq!(
            after_status.stdout, before_status.stdout,
            "worktree status must stay unchanged"
        );
        assert_eq!(
            after_index.stdout, before_index.stdout,
            "the index must stay unchanged"
        );
    }
}

#[cfg(not(windows))]
#[test]
fn discard_file_does_not_expand_an_untracked_pathspec_magic_filename() {
    let repo = TempRepo::new("discard-file-pathspec-magic");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("tracked-a.txt"), "a\n").unwrap();
    std::fs::write(repo.0.join("tracked-b.txt"), "b\n").unwrap();
    repo.git_ok(&["add", "-A"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    let magic = ":(glob)*";
    std::fs::write(repo.0.join(magic), "untracked\n").unwrap();

    discard_current(&repo, magic, None, false).expect("discard literal magic filename");

    assert!(!repo.0.join(magic).exists());
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked-a.txt")).unwrap(),
        "a\n"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("tracked-b.txt")).unwrap(),
        "b\n"
    );
    let status = repo.git(&["status", "--porcelain", "--untracked-files=all"]);
    assert!(
        String::from_utf8_lossy(&status.stdout).trim().is_empty(),
        "tracked files must not be removed or staged: {}",
        String::from_utf8_lossy(&status.stdout)
    );
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

    discard_current(&repo, "staged_new.txt", None, true).expect("discard staged=true new file");
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

    discard_current(&repo, "new.txt", None, true).expect("discard staged file on unborn HEAD");
    assert!(index_entries(&repo).is_empty(), "file leaves the index");
    assert!(!repo.0.join("new.txt").exists(), "file leaves the worktree");
}

#[test]
fn discard_staged_file_fails_closed_when_head_tree_cannot_be_read() {
    let repo = repo_with_file("discard-missing-head-tree", "root.txt", b"root\n");
    std::fs::create_dir(repo.0.join("nested")).unwrap();
    std::fs::write(repo.0.join("nested/tracked.txt"), b"committed\n").unwrap();
    repo.git_ok(&["add", "nested/tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "add nested file"]);
    std::fs::write(repo.0.join("nested/tracked.txt"), b"staged edit\n").unwrap();
    repo.git_ok(&["add", "nested/tracked.txt"]);

    let subtree = rev_parse(&repo, "HEAD:nested");
    let object_path = repo
        .0
        .join(".git/objects")
        .join(&subtree[..2])
        .join(&subtree[2..]);
    std::fs::remove_file(&object_path).expect("fixture subtree object should be loose");

    let error = preview_discard_file(repo.path(), "nested/tracked.txt", None, true)
        .expect_err("an unreadable HEAD tree must never be treated as a staged-new file");
    assert!(
        error.contains("Could not inspect") || error.contains("unable to read tree"),
        "unexpected error: {error}"
    );
    assert_eq!(
        std::fs::read(repo.0.join("nested/tracked.txt")).unwrap(),
        b"staged edit\n"
    );
    assert_eq!(index_entries(&repo), ["nested/tracked.txt", "root.txt"]);
}

#[test]
fn discard_file_refuses_a_same_size_edit_after_preview() {
    let repo = repo_with_file("discard-stale-same-size", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("loose.txt"), b"one\n").unwrap();
    let preview = preview_discard_file(repo.path(), "loose.txt", None, false).expect("preview");

    // Same byte length and line count: a size/stat-only precondition would miss
    // this replacement and delete content created while the dialog was open.
    std::fs::write(repo.0.join("loose.txt"), b"two\n").unwrap();
    let error = discard_file(
        repo.path(),
        "loose.txt",
        None,
        false,
        &preview.expected_state,
    )
    .expect_err("changed content must invalidate the preview");

    assert!(error.contains("changed"), "unexpected error: {error}");
    assert_eq!(std::fs::read(repo.0.join("loose.txt")).unwrap(), b"two\n");
    assert_eq!(index_entries(&repo), ["tracked.txt"]);
}

#[test]
fn discard_unstaged_side_of_staged_new_preserves_the_staged_blob() {
    let repo = repo_with_file("discard-staged-new-edited", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("new.txt"), b"staged version\n").unwrap();
    repo.git_ok(&["add", "new.txt"]);
    std::fs::write(repo.0.join("new.txt"), b"working edit!!\n").unwrap();

    discard_current(&repo, "new.txt", None, false)
        .expect("discard only the unstaged side of a staged-new file");

    assert_eq!(
        std::fs::read(repo.0.join("new.txt")).unwrap(),
        b"staged version\n"
    );
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["show", ":new.txt"]).stdout),
        "staged version\n"
    );
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["status", "--porcelain=v1"]).stdout),
        "A  new.txt\n"
    );
}

#[test]
fn discard_staged_deletion_rejects_a_new_worktree_copy_then_restores_head() {
    let repo = repo_with_file("discard-staged-deletion", "gone.txt", b"committed\n");
    repo.git_ok(&["rm", "-q", "gone.txt"]);
    let preview = preview_discard_file(repo.path(), "gone.txt", None, true).expect("preview");

    std::fs::write(repo.0.join("gone.txt"), b"precious\n").unwrap();
    let error = discard_file(repo.path(), "gone.txt", None, true, &preview.expected_state)
        .expect_err("a new worktree copy invalidates the deletion preview");
    assert!(error.contains("changed"), "unexpected error: {error}");
    assert_eq!(
        std::fs::read(repo.0.join("gone.txt")).unwrap(),
        b"precious\n"
    );
    assert!(repo.git(&["diff", "--cached", "--quiet"]).status.code() == Some(1));

    discard_current(&repo, "gone.txt", None, true).expect("restore staged deletion");
    assert_eq!(
        std::fs::read(repo.0.join("gone.txt")).unwrap(),
        b"committed\n"
    );
    assert!(repo.git(&["status", "--porcelain"]).stdout.is_empty());
}

#[test]
fn discard_intent_to_add_rejects_a_real_stage_transition_and_removes_a_live_ita() {
    let repo = repo_with_file("discard-intent-to-add", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("intent.txt"), b"draft\n").unwrap();
    repo.git_ok(&["add", "-N", "intent.txt"]);
    let preview = preview_discard_file(repo.path(), "intent.txt", None, false).expect("preview");

    repo.git_ok(&["add", "intent.txt"]);
    let error = discard_file(
        repo.path(),
        "intent.txt",
        None,
        false,
        &preview.expected_state,
    )
    .expect_err("turning intent-to-add into staged content must fail closed");
    assert!(
        error.contains("no longer available") || error.contains("changed"),
        "unexpected error: {error}"
    );
    assert!(repo.0.join("intent.txt").exists());
    assert!(index_entries(&repo).contains(&"intent.txt".to_string()));

    repo.git_ok(&["reset", "-q", "HEAD", "--", "intent.txt"]);
    repo.git_ok(&["add", "-N", "intent.txt"]);
    discard_current(&repo, "intent.txt", None, false)
        .expect("git rm -f removes an intent-to-add entry and worktree copy");
    assert!(!repo.0.join("intent.txt").exists());
    assert!(!index_entries(&repo).contains(&"intent.txt".to_string()));
}

#[test]
fn discard_rename_refuses_content_changed_after_preview() {
    for staged in [false, true] {
        let repo = repo_with_file(
            if staged {
                "discard-staged-rename-content-race"
            } else {
                "discard-unstaged-rename-content-race"
            },
            "old.txt",
            b"base\n",
        );
        if staged {
            repo.git_ok(&["mv", "old.txt", "new.txt"]);
        } else {
            std::fs::rename(repo.0.join("old.txt"), repo.0.join("new.txt")).unwrap();
        }
        let preview = preview_discard_file(repo.path(), "new.txt", Some("old.txt"), staged)
            .expect("preview rename");
        let before_index = repo.git(&["diff", "--cached", "--binary"]).stdout;

        std::fs::write(repo.0.join("new.txt"), b"late\n").unwrap();
        let error = discard_file(
            repo.path(),
            "new.txt",
            Some("old.txt"),
            staged,
            &preview.expected_state,
        )
        .expect_err("rename content changed after preview");

        assert!(error.contains("changed"), "unexpected error: {error}");
        assert!(!repo.0.join("old.txt").exists());
        assert_eq!(std::fs::read(repo.0.join("new.txt")).unwrap(), b"late\n");
        assert_eq!(
            repo.git(&["diff", "--cached", "--binary"]).stdout,
            before_index
        );
    }
}

#[test]
fn discard_preview_rejects_conflicted_paths_without_mutation() {
    let repo = repo_with_file("discard-conflict", "conflict.txt", b"base\n");
    repo.git_ok(&["checkout", "-q", "-b", "side"]);
    std::fs::write(repo.0.join("conflict.txt"), b"side\n").unwrap();
    repo.git_ok(&["add", "conflict.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "side"]);
    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("conflict.txt"), b"main\n").unwrap();
    repo.git_ok(&["add", "conflict.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "main"]);
    let merge = repo.git(&["merge", "--no-edit", "side"]);
    assert!(!merge.status.success(), "fixture must produce a conflict");
    let before_index = repo.git(&["ls-files", "-u"]).stdout;
    let before_worktree = std::fs::read(repo.0.join("conflict.txt")).unwrap();

    let error = preview_discard_file(repo.path(), "conflict.txt", None, false)
        .expect_err("ordinary discard must refuse conflicts");

    assert!(error.contains("conflicted"), "unexpected error: {error}");
    assert_eq!(repo.git(&["ls-files", "-u"]).stdout, before_index);
    assert_eq!(
        std::fs::read(repo.0.join("conflict.txt")).unwrap(),
        before_worktree
    );
}

#[test]
fn discard_expectation_tolerates_unrelated_path_and_index_changes() {
    let repo = repo_with_file("discard-unrelated-tolerance", "target.txt", b"base\n");
    std::fs::write(repo.0.join("target.txt"), b"target edit\n").unwrap();
    let preview = preview_discard_file(repo.path(), "target.txt", None, false).expect("preview");

    std::fs::write(repo.0.join("other.txt"), b"other\n").unwrap();
    repo.git_ok(&["add", "other.txt"]);
    discard_file(
        repo.path(),
        "target.txt",
        None,
        false,
        &preview.expected_state,
    )
    .expect("unrelated state must not invalidate a path-local expectation");

    assert_eq!(std::fs::read(repo.0.join("target.txt")).unwrap(), b"base\n");
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["show", ":other.txt"]).stdout),
        "other\n"
    );
}

#[test]
fn discard_roots_the_subprocess_at_the_discovered_worktree() {
    let repo = repo_with_file("discard-nested-caller-root", "file.txt", b"root base\n");
    std::fs::create_dir(repo.0.join("subdir")).unwrap();
    std::fs::write(repo.0.join("subdir/file.txt"), b"nested base\n").unwrap();
    repo.git_ok(&["add", "subdir/file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "nested file"]);
    std::fs::write(repo.0.join("file.txt"), b"root edit\n").unwrap();
    std::fs::write(repo.0.join("subdir/file.txt"), b"nested precious\n").unwrap();
    let preview = preview_discard_file(repo.path(), "file.txt", None, false).expect("preview");
    let nested_caller = repo.0.join("subdir");

    discard_file(
        nested_caller.to_str().unwrap(),
        "file.txt",
        None,
        false,
        &preview.expected_state,
    )
    .expect("the discovered root owns both the lease and pathspec");

    assert_eq!(
        std::fs::read(repo.0.join("file.txt")).unwrap(),
        b"root base\n"
    );
    assert_eq!(
        std::fs::read(repo.0.join("subdir/file.txt")).unwrap(),
        b"nested precious\n"
    );
}

#[test]
fn discard_revalidates_path_observations_after_the_content_pass() {
    let repo = repo_with_file("discard-final-leaf-recheck", "old.txt", b"base\n");
    repo.git_ok(&["mv", "old.txt", "new.txt"]);
    // Reverse the rename only in the worktree. Both paths remain inside the
    // staged row's operand set, so this is safe to preview as one logical row.
    std::fs::rename(repo.0.join("new.txt"), repo.0.join("old.txt")).unwrap();
    let preview = preview_discard_file(repo.path(), "new.txt", Some("old.txt"), true)
        .expect("preview the staged rename with its opposite worktree rename");
    let before_index = repo.git(&["diff", "--cached", "--binary"]).stdout;
    let hook_path = repo.0.join("old.txt");
    set_discard_capture_test_hook(move || {
        // Same size, after this earlier rename operand has already been hashed.
        std::fs::write(hook_path, b"late\n").unwrap();
    });

    let error = discard_file(
        repo.path(),
        "new.txt",
        Some("old.txt"),
        true,
        &preview.expected_state,
    )
    .expect_err("the final pathname observation must reject the late edit");

    assert!(error.contains("changed"), "unexpected error: {error}");
    assert_eq!(std::fs::read(repo.0.join("old.txt")).unwrap(), b"late\n");
    assert!(!repo.0.join("new.txt").exists());
    assert_eq!(
        repo.git(&["diff", "--cached", "--binary"]).stdout,
        before_index
    );
}

#[test]
fn discard_revalidates_index_semantics_after_the_content_pass() {
    let repo = repo_with_file("discard-final-index-recheck", "target.txt", b"base\n");
    std::fs::write(repo.0.join("target.txt"), b"edit\n").unwrap();
    let preview = preview_discard_file(repo.path(), "target.txt", None, false).expect("preview");
    let hook_repo = repo.0.clone();
    set_discard_capture_test_hook(move || {
        let output = Command::new("git")
            .arg("-C")
            .arg(hook_repo)
            .args(["add", "target.txt"])
            .output()
            .expect("git launches in capture hook");
        assert!(
            output.status.success(),
            "hook git add failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    });

    let error = discard_file(
        repo.path(),
        "target.txt",
        None,
        false,
        &preview.expected_state,
    )
    .expect_err("the fresh semantic capture must reject the staged transition");

    assert!(error.contains("changed"), "unexpected error: {error}");
    assert_eq!(std::fs::read(repo.0.join("target.txt")).unwrap(), b"edit\n");
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["show", ":target.txt"]).stdout),
        "edit\n"
    );
}

#[test]
fn discard_staged_change_rejects_an_external_worktree_rename() {
    let repo = repo_with_file("discard-staged-then-wt-rename", "old.txt", b"base\n");
    std::fs::write(repo.0.join("old.txt"), b"stage\n").unwrap();
    repo.git_ok(&["add", "old.txt"]);
    std::fs::rename(repo.0.join("old.txt"), repo.0.join("new.txt")).unwrap();
    let before_status = repo.git(&["status", "--porcelain=v1", "-z"]).stdout;
    let before_index = repo.git(&["diff", "--cached", "--binary"]).stdout;

    let error = preview_discard_file(repo.path(), "old.txt", None, true)
        .expect_err("a staged row must not strand its external worktree rename");

    assert!(
        error.contains("unstaged rename first"),
        "unexpected error: {error}"
    );
    assert_eq!(
        repo.git(&["status", "--porcelain=v1", "-z"]).stdout,
        before_status
    );
    assert_eq!(
        repo.git(&["diff", "--cached", "--binary"]).stdout,
        before_index
    );
    assert!(!repo.0.join("old.txt").exists());
    assert_eq!(std::fs::read(repo.0.join("new.txt")).unwrap(), b"stage\n");
}

#[test]
fn discard_staged_rename_rejects_a_later_external_worktree_rename() {
    let repo = repo_with_file("discard-staged-rename-chain", "old.txt", b"base\n");
    repo.git_ok(&["mv", "old.txt", "new.txt"]);
    std::fs::rename(repo.0.join("new.txt"), repo.0.join("newer.txt")).unwrap();
    let before_status = repo.git(&["status", "--porcelain=v1", "-z"]).stdout;
    let before_index = repo.git(&["diff", "--cached", "--binary"]).stdout;

    let error = preview_discard_file(repo.path(), "new.txt", Some("old.txt"), true)
        .expect_err("a staged rename must not strand the next worktree rename");

    assert!(
        error.contains("unstaged rename first"),
        "unexpected error: {error}"
    );
    assert_eq!(
        repo.git(&["status", "--porcelain=v1", "-z"]).stdout,
        before_status
    );
    assert_eq!(
        repo.git(&["diff", "--cached", "--binary"]).stdout,
        before_index
    );
    assert!(!repo.0.join("old.txt").exists());
    assert!(!repo.0.join("new.txt").exists());
    assert_eq!(std::fs::read(repo.0.join("newer.txt")).unwrap(), b"base\n");
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
    assert!(
        dir.0.join(".git/HEAD").is_file(),
        "init must have run for real"
    );
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
    assert!(
        dir.0.join(".git").is_dir(),
        "the stale .git file must be replaced with a real gitdir"
    );
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
    assert!(
        dir_with_space.join(".git").is_dir(),
        "the spaced directory must be initialized"
    );
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

fn repo_file_lease(repo: &str, file: &str) -> (u64, String) {
    let content = crate::git::status::repo_file_text(repo, file, None).expect("editable read");
    (
        content.size,
        content.expected_state.expect("lossless text has a lease"),
    )
}

#[test]
fn write_repo_file_overwrites_and_reports_new_size() {
    let repo = repo_with_file("wrf-ok", "a.txt", b"old\n");
    let (size, state) = repo_file_lease(repo.path(), "a.txt");
    let result =
        write_repo_file(repo.path(), "a.txt", "new content\n", size, &state).expect("write ok");
    assert_eq!(result.size, "new content\n".len() as u64);
    assert_ne!(result.expected_state, state);
    assert_eq!(
        std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
        "new content\n"
    );
}

#[test]
fn write_repo_file_rejects_size_mismatch() {
    let repo = repo_with_file("wrf-size", "a.txt", b"old\n");
    let (_, state) = repo_file_lease(repo.path(), "a.txt");
    // On-disk is 4 bytes; a caller that loaded a different size (or a truncated
    // >2 MiB prefix) must be refused before the unseen remainder is destroyed.
    let err = write_repo_file(repo.path(), "a.txt", "x", 999, &state).unwrap_err();
    assert!(err.contains("changed on disk"), "unexpected: {err}");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
        "old\n"
    );
}

#[test]
fn write_repo_file_refuses_new_file() {
    let repo = repo_with_file("wrf-new", "a.txt", b"old\n");
    let (size, state) = repo_file_lease(repo.path(), "a.txt");
    // Overwrite-only: the panel never lists a nonexistent path.
    assert!(write_repo_file(repo.path(), "nope.txt", "x", size, &state).is_err());
    assert!(!repo.0.join("nope.txt").exists());
}

#[test]
fn write_repo_file_refuses_binary_content_and_binary_target() {
    let repo = repo_with_file("wrf-bin", "a.txt", b"old\n");
    let (size, state) = repo_file_lease(repo.path(), "a.txt");
    // NUL in the incoming content — scanned in full, not just the sniff window.
    assert!(write_repo_file(repo.path(), "a.txt", "a\0b", size, &state).is_err());
    let late_nul = format!("{}\0", "x".repeat(9000));
    assert!(write_repo_file(repo.path(), "a.txt", &late_nul, size, &state).is_err());
    assert_eq!(
        std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
        "old\n"
    );

    // NUL already on disk — an editor should never have offered it as text.
    let bin = repo_with_file("wrf-bin2", "b.bin", b"\0\0\0\0");
    let err = write_repo_file(bin.path(), "b.bin", "text", 4, &state).unwrap_err();
    assert!(err.contains("changed on disk"), "unexpected: {err}");
}

#[test]
fn write_repo_file_refuses_oversized_and_dotgit_paths() {
    let repo = repo_with_file("wrf-cap", "a.txt", b"old\n");
    let (size, state) = repo_file_lease(repo.path(), "a.txt");
    // A file larger than the read cap could only have been read as a prefix.
    let big = repo.0.join("big.txt");
    std::fs::write(&big, vec![b'x'; 2 * 1024 * 1024 + 1]).unwrap();
    let err = write_repo_file(repo.path(), "big.txt", "x", size, &state).unwrap_err();
    assert!(err.contains("too large"), "unexpected: {err}");

    // Incoming content is capped too — a small file can't be grown past the cap.
    let huge = "x".repeat(2 * 1024 * 1024 + 1);
    let err = write_repo_file(repo.path(), "a.txt", &huge, size, &state).unwrap_err();
    assert!(err.contains("too large"), "unexpected: {err}");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
        "old\n"
    );

    // The raw IPC surface must not be pointed at repository metadata.
    assert!(write_repo_file(repo.path(), ".git/config", "x", size, &state).is_err());
    assert!(write_repo_file(repo.path(), ".GIT/config", "x", size, &state).is_err());
}

#[test]
fn write_repo_file_leaves_original_intact_and_preserves_mode() {
    let repo = repo_with_file("wrf-atomic", "a.sh", b"#!/bin/sh\necho hi\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(repo.0.join("a.sh"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        let before = std::fs::metadata(repo.0.join("a.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let (size, state) = repo_file_lease(repo.path(), "a.sh");
        write_repo_file(repo.path(), "a.sh", "#!/bin/sh\necho bye\n", size, &state)
            .expect("write ok");
        let after = std::fs::metadata(repo.0.join("a.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            before, after,
            "executable bit must survive the atomic replace"
        );
    }
    assert_eq!(
        std::fs::read_to_string(repo.0.join("a.sh")).unwrap(),
        "#!/bin/sh\necho bye\n"
    );
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
    let (size, state) = repo_file_lease(repo.path(), "a.txt");
    assert!(write_repo_file(repo.path(), "../escape.txt", "x", size, &state).is_err());
    assert!(write_repo_file(repo.path(), "/etc/hosts", "x", size, &state).is_err());

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;

        symlink("a.txt", repo.0.join("link.txt")).unwrap();
        // A symlink is not a regular file — refuse rather than follow it.
        assert!(write_repo_file(repo.path(), "link.txt", "x", size, &state).is_err());

        let outside = repo.0.with_extension("editor-outside");
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("target.txt"), "outside\n").unwrap();
        symlink(&outside, repo.0.join("ancestor-link")).unwrap();
        assert!(write_repo_file(
            repo.path(),
            "ancestor-link/target.txt",
            "changed\n",
            8,
            &state
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(outside.join("target.txt")).unwrap(),
            "outside\n"
        );
        let _ = std::fs::remove_dir_all(&outside);
    }
}

#[test]
fn write_repo_file_rejects_same_size_external_edit() {
    let repo = repo_with_file("wrf-same-size", "a.txt", b"old\n");
    let (size, state) = repo_file_lease(repo.path(), "a.txt");
    std::fs::write(repo.0.join("a.txt"), b"new\n").unwrap();

    let err = write_repo_file(repo.path(), "a.txt", "mine\n", size, &state).unwrap_err();
    assert!(
        err.contains("contents or file identity"),
        "unexpected: {err}"
    );
    assert_eq!(std::fs::read(repo.0.join("a.txt")).unwrap(), b"new\n");
}

#[test]
fn write_repo_file_rejects_identical_atomic_replacement_after_read() {
    let repo = repo_with_file("wrf-replaced-before", "a.txt", b"old\n");
    let (size, state) = repo_file_lease(repo.path(), "a.txt");
    let replacement = repo.0.join("replacement.txt");
    std::fs::write(&replacement, b"old\n").unwrap();
    std::fs::rename(replacement, repo.0.join("a.txt")).unwrap();

    let err = write_repo_file(repo.path(), "a.txt", "mine\n", size, &state).unwrap_err();
    assert!(err.contains("file identity"), "unexpected: {err}");
    assert_eq!(std::fs::read(repo.0.join("a.txt")).unwrap(), b"old\n");
}

#[test]
fn write_repo_file_rechecks_leaf_identity_immediately_before_rename() {
    let repo = repo_with_file("wrf-replaced-during", "a.txt", b"old\n");
    let (size, state) = repo_file_lease(repo.path(), "a.txt");
    let target = repo.0.join("a.txt");
    set_before_replace_test_hook(move || {
        let replacement = target.with_extension("replacement");
        std::fs::write(&replacement, b"other\n").unwrap();
        std::fs::rename(replacement, target).unwrap();
    });

    let err = write_repo_file(repo.path(), "a.txt", "mine\n", size, &state).unwrap_err();
    assert!(err.contains("changed while"), "unexpected: {err}");
    assert_eq!(std::fs::read(repo.0.join("a.txt")).unwrap(), b"other\n");
}

#[test]
fn write_repo_file_refuses_a_lease_when_published_inode_is_replaced() {
    let repo = repo_with_file("wrf-replaced-after", "a.txt", b"old\n");
    let (size, state) = repo_file_lease(repo.path(), "a.txt");
    let target = repo.0.join("a.txt");
    set_after_guarded_rename_test_hook(move || {
        let replacement = target.with_extension("external");
        std::fs::write(&replacement, b"external\n").unwrap();
        std::fs::rename(replacement, target).unwrap();
    });

    let err = write_repo_file(repo.path(), "a.txt", "mine\n", size, &state).unwrap_err();
    assert!(err.contains("changed while"), "unexpected: {err}");
    assert_eq!(std::fs::read(repo.0.join("a.txt")).unwrap(), b"external\n");
}

#[test]
fn write_repo_file_returns_the_lease_for_a_sequential_save() {
    let repo = repo_with_file("wrf-sequential", "a.txt", b"zero\n");
    let (size, state) = repo_file_lease(repo.path(), "a.txt");
    let first = write_repo_file(repo.path(), "a.txt", "one\n", size, &state).expect("first save");
    let second = write_repo_file(
        repo.path(),
        "a.txt",
        "two\n",
        first.size,
        &first.expected_state,
    )
    .expect("second save uses returned lease");
    assert_eq!(second.size, 4);
    assert_eq!(std::fs::read(repo.0.join("a.txt")).unwrap(), b"two\n");
}

#[test]
fn write_repo_file_rejects_missing_and_malformed_state_tokens() {
    let repo = repo_with_file("wrf-token-format", "a.txt", b"old\n");
    assert!(write_repo_file(repo.path(), "a.txt", "mine\n", 4, "")
        .unwrap_err()
        .contains("missing file state token"));
    assert!(
        write_repo_file(repo.path(), "a.txt", "mine\n", 4, "v1:not-this-domain")
            .unwrap_err()
            .contains("invalid file state token")
    );
    assert_eq!(std::fs::read(repo.0.join("a.txt")).unwrap(), b"old\n");
}

#[test]
fn write_repo_file_state_cannot_be_replayed_across_worktrees_or_nested_repos() {
    let repo = repo_with_file("wrf-token-scope", "a.txt", b"same\n");
    let (size, state) = repo_file_lease(repo.path(), "a.txt");

    let linked = repo.0.with_extension("linked-worktree");
    let _ = std::fs::remove_dir_all(&linked);
    let linked_path = linked.to_string_lossy().into_owned();
    repo.git_ok(&["worktree", "add", "-q", "-b", "linked", &linked_path]);
    let linked_err = write_repo_file(&linked_path, "a.txt", "mine\n", size, &state).unwrap_err();
    assert!(
        linked_err.contains("file identity"),
        "unexpected: {linked_err}"
    );

    let nested = repo.0.join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    git_ok_at(&nested, &["init", "-q", "-b", "main"]);
    git_ok_at(&nested, &["config", "user.name", "GitLane Test"]);
    git_ok_at(&nested, &["config", "user.email", "gitlane@example.test"]);
    std::fs::write(nested.join("a.txt"), b"same\n").unwrap();
    git_ok_at(&nested, &["add", "a.txt"]);
    git_ok_at(&nested, &["commit", "-q", "-m", "seed"]);
    let nested_path = nested.to_string_lossy().into_owned();
    let nested_err = write_repo_file(&nested_path, "a.txt", "mine\n", size, &state).unwrap_err();
    assert!(
        nested_err.contains("file identity"),
        "unexpected: {nested_err}"
    );

    repo.git_ok(&["worktree", "remove", "--force", &linked_path]);
}

/// Every `LeaseError` variant, rendered by both operations, pinned to its exact
/// text.
///
/// The shared primitives report a typed failure and each module words it, so the
/// wording is now the thing a refactor can quietly break — and it breaks
/// silently: swapping two arms leaves both strings present in the tree, so a
/// "no literal changed" check still passes. Substring assertions elsewhere in
/// this file would not catch it either. Hence exact strings, both renderers,
/// every variant (GL-332).
#[test]
fn lease_errors_render_in_each_operations_own_words() {
    use crate::git::write::state_lease::LeaseError;

    let cases: Vec<(LeaseError, LeaseError, &str, &str)> = vec![
        (
            LeaseError::WorkdirNotUtf8,
            LeaseError::WorkdirNotUtf8,
            "Cannot run Discard all from a worktree path that is not valid UTF-8.",
            "Cannot lease a hard reset from a worktree path that is not valid UTF-8.",
        ),
        (
            LeaseError::OpenRepository(git2::Error::from_str("boom")),
            LeaseError::OpenRepository(git2::Error::from_str("boom")),
            "Could not inspect the repository before discarding: boom",
            "Could not inspect the repository before hard reset: boom",
        ),
        (
            LeaseError::BareRepository,
            LeaseError::BareRepository,
            "Cannot discard changes in a bare repository.",
            "Cannot hard-reset a bare repository.",
        ),
        (
            LeaseError::NonUtf8GitPath,
            LeaseError::NonUtf8GitPath,
            "Discard all cannot safely represent a non-UTF-8 Git path on this platform.",
            "Hard reset cannot safely represent a non-UTF-8 Git path on this platform.",
        ),
        (
            LeaseError::ReplaceRefsActive,
            LeaseError::ReplaceRefsActive,
            "Discard all is unavailable while Git replacement refs are active. Remove the replacement refs or use the terminal.",
            "Hard reset is unavailable while Git replacement refs are active. Remove the replacement refs or use the terminal.",
        ),
        (
            LeaseError::InspectHead(git2::Error::from_str("boom")),
            LeaseError::InspectHead(git2::Error::from_str("boom")),
            "Could not inspect HEAD before discarding: boom",
            "Could not inspect HEAD before hard reset: boom",
        ),
        (
            LeaseError::ResolveHead(git2::Error::from_str("boom")),
            LeaseError::ResolveHead(git2::Error::from_str("boom")),
            "Could not resolve HEAD before discarding: boom",
            "Could not resolve HEAD before hard reset: boom",
        ),
        (
            LeaseError::NonFileWorktreePath {
                label: "sub".to_string(),
                kind: 4,
                mode: 0o40755,
            },
            LeaseError::NonFileWorktreePath {
                label: "sub".to_string(),
                kind: 4,
                mode: 0o40755,
            },
            "Refusing to discard non-file worktree path sub (type 4, mode 40755). Move the directory or nested repository aside and try again.",
            "Refusing to hard-reset while non-file worktree path sub is present (type 4, mode 40755). Move it aside and try again.",
        ),
        (
            // Shared text: both operations must render it identically.
            LeaseError::Worded("Could not resolve the repository worktree: boom".to_string()),
            LeaseError::Worded("Could not resolve the repository worktree: boom".to_string()),
            "Could not resolve the repository worktree: boom",
            "Could not resolve the repository worktree: boom",
        ),
    ];

    for (discard_error, hard_error, discard_text, hard_text) in cases {
        assert_eq!(
            super::discard_all::describe_lease_error(discard_error),
            discard_text
        );
        assert_eq!(
            super::hard_reset_lease::describe_lease_error(hard_error),
            hard_text
        );
    }
}
