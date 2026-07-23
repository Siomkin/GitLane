//! Shared fixtures and helpers for `git::write` integration tests.
#![allow(dead_code)]

pub(super) use super::super::branch_checkout::align_equivalent_sibling;
pub(super) use super::super::conflict_resolution::{
    conflict_stage_absent, is_empty_after_resolution,
};
pub(super) use super::super::lifecycle::init_in_place;
pub(super) use super::super::operands::ensure_operand;
pub(super) use super::super::patch_staging::{apply_hunk_patch, patch_diff_args};
pub(super) use super::super::remotes::{
    is_concurrent_fetch_ref_update, is_missing_remote_ref, is_tag_clobber_rejection,
    push_endpoint_token, push_target_at,
};
pub(super) use super::super::worktrees::is_porcelain_record;
pub(super) use super::super::{
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
    reconflict_file, reflog_entries, remove_worktree, reset_branch, resolve_conflict_file,
    restore_path_from_commit, revert, revert_many, revert_onto, set_before_replace_test_hook,
    set_discard_all_after_cleanup_test_hook, set_discard_all_after_first_clean_batch_test_hook,
    set_discard_all_after_tracked_scope_validation_test_hook,
    set_discard_all_after_validation_test_hook, set_discard_all_before_tracked_reset_test_hook,
    set_discard_all_capture_test_hook, set_discard_capture_test_hook,
    set_hard_reset_after_fingerprint_test_hook, set_hard_reset_after_validation_test_hook,
    set_hard_reset_before_mutation_test_hook, set_hard_reset_capture_test_hook, set_remote_url,
    set_remote_username, set_repo_identity, set_squash_after_commit_test_hook,
    set_squash_after_read_tree_test_hook, set_upstream, skip_operation, squash_commits, stage_file,
    stage_files, start_discard_all_fingerprint_byte_count, stash, stash_apply,
    stash_apply_index_onto, stash_apply_onto, stash_branch, stash_drop, stash_expected, stash_list,
    stash_pop, stash_pop_onto, take_discard_all_fingerprint_byte_count, unstage_all, unstage_file,
    unstage_files, worktree_differs_from_commit, worktree_dirty_state, worktree_is_dirty,
    worktrees, write_repo_file,
};
pub(super) use crate::git::read::repo_identity;
pub(super) use crate::git::transport_auth::{
    credential_for_remote, ProviderTokenBridge, RemoteTransportDirection, TransportCredential,
};
pub(super) use crate::git::types::{ForcePushRouteLease, GitTransportAuthRef};
pub(super) use crate::git::worktree_fs::set_after_guarded_rename_test_hook;
pub(super) use std::path::PathBuf;
pub(super) use std::process::Command;
pub(super) use std::sync::atomic::{AtomicU32, Ordering};

pub(super) const CLEAN_PATH_BATCH_MAX_ARGS: usize = 500;

pub(super) fn discard_all_previewed(repo: &str) -> Result<String, String> {
    let preview = preview_discard_all(repo)?;
    discard_all(
        repo,
        &preview.expected_state,
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
}

pub(super) fn remove_worktree_previewed(repo: &str, worktree_path: &str) -> Result<String, String> {
    let preview = preview_remove_worktree(repo, worktree_path)?;
    remove_worktree(repo, worktree_path, &preview.expected_state)
}

pub(super) fn delete_branch_with_worktree_previewed(
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

/// A throwaway temp directory that cleans itself up on drop — keeps the test
/// dependency-free (no `tempfile` dev-dep) while never leaking dirs.
pub(super) struct TempRepo(pub(super) PathBuf);

impl TempRepo {
    pub(super) fn new(tag: &str) -> Self {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("gitlane-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        TempRepo(dir)
    }
    pub(super) fn path(&self) -> &str {
        self.0.to_str().unwrap()
    }
    pub(super) fn git(&self, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .arg("-C")
            .arg(&self.0)
            .args(args)
            .output()
            .expect("git launches in tests")
    }
    pub(super) fn git_ok(&self, args: &[&str]) {
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

pub(super) fn rev_parse(repo: &TempRepo, rev: &str) -> String {
    let out = repo.git(&["rev-parse", rev]);
    assert!(out.status.success(), "rev-parse {rev} should resolve");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

pub(super) fn tip_range_for_squash(tag: &str) -> (TempRepo, String, String) {
    let (repo, base) = repo_with_base_commit(tag);
    std::fs::write(repo.0.join("f.txt"), "one\n").unwrap();
    repo.git_ok(&["commit", "-q", "-a", "-m", "one"]);
    std::fs::write(repo.0.join("f.txt"), "two\n").unwrap();
    repo.git_ok(&["commit", "-q", "-a", "-m", "two"]);
    let tip = rev_parse(&repo, "HEAD");
    (repo, base, tip)
}

/// Build `base ─ main work ─ M` on `main` where `M` merges a `feature` branch
/// that added `feature.txt` (so `M`'s first parent is the mainline commit with
/// `main.txt`). Returns the repo and the merge commit's sha.
pub(super) fn repo_with_merged_feature(tag: &str) -> (TempRepo, String) {
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

/// A throwaway linked-worktree directory (lives outside the repo dir, so it needs
/// its own cleanup) that removes itself on drop.
pub(super) struct LinkedDir(pub(super) PathBuf);

impl LinkedDir {
    pub(super) fn new(tag: &str) -> Self {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("gitlane-{tag}-linked-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        LinkedDir(dir)
    }
    pub(super) fn as_str(&self) -> &str {
        self.0.to_str().unwrap()
    }
}

impl Drop for LinkedDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(super) fn git_at(dir: &std::path::Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("git launches in tests")
}

pub(super) fn git_ok_at(dir: &std::path::Path, args: &[&str]) {
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
pub(super) fn repo_with_feature_worktree(tag: &str) -> (TempRepo, LinkedDir) {
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

pub(super) fn is_detached(dir: &std::path::Path) -> bool {
    !git_at(dir, &["symbolic-ref", "--quiet", "HEAD"])
        .status
        .success()
}

// The progress step ids are the UI contract for the hand-off dialog's live
// checklist: assert the happy-path order for a dirty source, and that the
// stash/apply steps never fire when everything is clean (the dialog folds the
// skipped rows in).

/// Set up a handoff whose destination re-apply genuinely conflicts: `feature`
/// changes file.txt one way (committed), the destination has an uncommitted change
/// to the same file the other way. Returns the repo (its linked worktree is kept
/// alive by the returned guard).
pub(super) fn handoff_into_conflict(tag: &str) -> (TempRepo, LinkedDir, String) {
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

/// A repo whose linked worktree is already dirty at preview time, for the drift
/// tests that need an existing porcelain record to mutate. Returns the repo, the
/// linked directory, and the tracked file inside it.
pub(super) fn repo_with_dirty_linked_worktree(tag: &str) -> (TempRepo, LinkedDir, PathBuf) {
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

pub(super) fn copy_dir_recursive(
    from: &std::path::Path,
    to: &std::path::Path,
) -> std::io::Result<()> {
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

/// A repo with one commit on `main` and a configured (but offline) origin.
/// `git config` here keeps commits unsigned so CI without a signing key works.
pub(super) fn repo_with_base_commit(tag: &str) -> (TempRepo, String) {
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

/// Build a modify/delete conflict: `base` committed, then HEAD modifies the
/// file while the merged branch deletes it. Returns the repo with the merge
/// stopped on the conflict (stage 2 = ours present, stage 3 = theirs absent).
pub(super) fn modify_delete_repo(tag: &str) -> TempRepo {
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

/// Build a content conflict: `base` committed, then `other` and `main` change
/// the same line. Returns the repo with the merge stopped on the conflict.
pub(super) fn merge_conflict_repo(tag: &str) -> TempRepo {
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

pub(super) fn remote_url(repo: &TempRepo, args: &[&str]) -> String {
    let out = repo.git(args);
    assert!(out.status.success(), "git {args:?} failed");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// Shared fixture for the pull tests: a seed repo with one commit on `main`
/// and a local clone of it. Returned as (root, seed, clone) — `root` owns the
/// parent temp dir, the other two wrap its subdirectories (their Drop is a
/// no-op after root's cleanup, which `remove_dir_all` tolerates).
pub(super) fn seed_and_clone(tag: &str) -> (TempRepo, TempRepo, TempRepo) {
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

/// A repo with one commit of `f.txt`, ready for stash churn (GL-117 tests).
pub(super) fn stash_seed_repo(tag: &str) -> TempRepo {
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

/// Restores a directory's mode on drop so a test that makes one unwritable
/// cannot leave `TempRepo`'s recursive delete unable to clean up.
#[cfg(unix)]
pub(super) struct RestoredMode(pub(super) PathBuf, pub(super) u32);

#[cfg(unix)]
impl RestoredMode {
    pub(super) fn clamp(path: PathBuf, mode: u32) -> Self {
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

/// Index entries (`git ls-files`) as owned lines, for asserting what is staged.
pub(super) fn index_entries(repo: &TempRepo) -> Vec<String> {
    let out = repo.git(&["ls-files"]);
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_string)
        .collect()
}

pub(super) fn discard_current(
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

/// Path compare that survives macOS `/var` → `/private/var` canonicalization.
pub(super) fn same_path(a: &str, b: &str) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a.trim_end_matches('/') == b.trim_end_matches('/'),
    }
}

/// A minimal committed repo with one text file, for the file-editor writes.
pub(super) fn repo_with_file(tag: &str, name: &str, contents: &[u8]) -> TempRepo {
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

pub(super) fn repo_file_lease(repo: &str, file: &str) -> (u64, String) {
    let content = crate::git::status::repo_file_text(repo, file, None).expect("editable read");
    (
        content.size,
        content.expected_state.expect("lossless text has a lease"),
    )
}
