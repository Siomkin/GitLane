use super::conflict_resolution::{conflict_stage_absent, is_empty_after_resolution, worktree_path};
use super::operands::ensure_operand;
use super::remotes::{is_missing_remote_ref, is_tag_clobber_rejection};
use super::staging::{apply_hunk_patch, patch_diff_args};
use super::{
    abort_operation, accept_conflict_side, apply_hunk, apply_line, clear_repo_identity,
    continue_operation, create_tag, delete_branch_with_worktree, delete_remote_tag, discard_all,
    fast_forward, fast_forward_branch, fetch, mark_conflict_resolved, merge,
    move_branch_to_worktree, preview_delete_branch,
    preview_delete_remote_branch, preview_discard_all, preview_force_push, preview_reset, pull,
    publish_branch, reconflict_file, reflog_entries, remove_worktree, resolve_conflict_file,
    set_remote_url, set_repo_identity, set_upstream, skip_operation, stage_files, worktrees,
};
use crate::git::read::repo_identity;
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
    set_repo_identity(repo.path(), "Work Dev", "work@example.test", None, None, None, None)
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
    assert_eq!(id.gpg_sign, Some(false), "gpgSign=false is written, not unset");
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

    delete_remote_tag(repo.path(), "origin", "v1", None).expect("delete tag on remote");

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
    delete_remote_tag(repo.path(), "origin", "v9", None)
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

    let result = move_branch_to_worktree(repo.path(), "feature", linked_str, repo.path(), false, &|_| {})
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

    let result = delete_branch_with_worktree(repo.path(), "feature", linked_str)
        .expect("delete branch and its worktree");
    assert_eq!(result, "Deleted feature and its worktree");

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

    let err = delete_branch_with_worktree(repo.path(), "feature", linked_str)
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

    let err = delete_branch_with_worktree(repo.path(), "feature", linked_str)
        .expect_err("a stale worktree path should abort the delete");
    assert!(err.contains("feature"), "error should name the branch, got: {err}");

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

    let err = move_branch_to_worktree(repo.path(), "feature", linked_str, repo.path(), false, &|_| {})
        .expect_err("a stale worktree path should abort the move");
    assert!(err.contains("feature"), "error should name the branch, got: {err}");
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
        let dir = std::env::temp_dir().join(format!(
            "gitlane-{tag}-linked-{}-{n}",
            std::process::id()
        ));
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
    move_branch_to_worktree(repo.path(), "feature", linked.as_str(), repo.path(), true, &|s| {
        steps.borrow_mut().push(s)
    })
    .expect("carry handoff");
    assert_eq!(
        steps.into_inner(),
        vec!["stashSource", "detach", "checkout", "applySource", "finalize"]
    );
}

#[test]
fn move_branch_to_worktree_skips_stash_steps_when_clean() {
    let (repo, linked) = repo_with_feature_worktree("handoff-progress-clean");

    let steps = std::cell::RefCell::new(Vec::new());
    move_branch_to_worktree(repo.path(), "feature", linked.as_str(), repo.path(), true, &|s| {
        steps.borrow_mut().push(s)
    })
    .expect("clean handoff");
    assert_eq!(steps.into_inner(), vec!["detach", "checkout", "finalize"]);
}

#[test]
fn move_branch_to_worktree_carries_dirty_source_changes() {
    let (repo, linked) = repo_with_feature_worktree("handoff-carry");
    // The AI-worktree case: uncommitted work in the linked (source) worktree.
    std::fs::write(linked.0.join("file.txt"), "carried\n").unwrap();
    std::fs::write(linked.0.join("new.txt"), "brand new\n").unwrap(); // untracked rides along

    let msg = move_branch_to_worktree(repo.path(), "feature", linked.as_str(), repo.path(), true, &|_| {})
        .expect("carry handoff");
    assert!(msg.contains("feature"), "message should name the branch: {msg}");

    // The destination (main worktree) is now on feature with the carried work.
    let current = repo.git(&["branch", "--show-current"]);
    assert_eq!(String::from_utf8_lossy(&current.stdout).trim(), "feature");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("file.txt")).unwrap(),
        "carried\n"
    );
    assert!(repo.0.join("new.txt").exists(), "untracked file should carry");
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

    let err = move_branch_to_worktree(repo.path(), "feature", linked.as_str(), repo.path(), false, &|_| {})
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

    let msg = move_branch_to_worktree(repo.path(), "feature", linked.as_str(), repo.path(), true, &|_| {})
        .expect("handoff onto a dirty destination");
    assert!(msg.contains("feature"), "message should name the branch: {msg}");

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

    let err = move_branch_to_worktree(repo.path(), "feature", linked.as_str(), repo.path(), true, &|_| {})
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
    assert!(!is_detached(&linked.0), "source must not be detached after a rollback");
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

    let msg = move_branch_to_worktree(repo.path(), "feature", linked.as_str(), repo.path(), true, &|_| {})
        .expect("handoff should land structurally even when the carry conflicts");
    (repo, linked, msg)
}

#[test]
fn move_branch_to_worktree_routes_carry_conflict_and_continues() {
    let (repo, _linked, msg) = handoff_into_conflict("handoff-conflict");
    assert!(msg.contains("resolve"), "message should ask to resolve: {msg}");

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
    assert_eq!(resolved.kind, "carry", "carry must survive resolving the last conflict");
    assert!(resolved.conflicts.is_empty(), "no conflicts remain once staged");

    // Finish the carry.
    let done = continue_operation(repo.path(), "carry", None, None).expect("continue carry");
    assert!(done.contains("Carried"), "unexpected continue message: {done}");

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
    assert!(done.contains("preserved"), "unexpected abort message: {done}");

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
    assert!(!merge.status.success(), "merge should conflict for the test setup");

    let err = move_branch_to_worktree(repo.path(), "feature", linked.as_str(), repo.path(), true, &|_| {})
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
    git_ok_at(bare.0.as_path(), &["worktree", "add", "-q", linked.as_str(), "feature"]);
    let gone = LinkedDir::new("wt-attrs-gone");
    git_ok_at(bare.0.as_path(), &["worktree", "add", "-q", "--detach", gone.as_str()]);
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
    let err = move_branch_to_worktree(bare.path(), "feature", linked.as_str(), bare.path(), true, &|_| {})
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

    apply_hunk(repo.path(), file, false, 0, "@@ -1,4 +1,4 @@", "-one\n+ONE\n 2\n 3\n 4")
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

    apply_hunk(repo.path(), "file.txt", true, 0, "@@ -1,4 +1,4 @@", "-one\n+ONE\n 2\n 3\n 4")
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

    apply_hunk(repo.path(), "gone.txt", false, 0, "@@ -1,3 +0,0 @@", "-one\n-two\n-three")
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

    let result = fetch(clone_repo.path(), None);
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

    let result = fetch(clone_repo.path(), None);
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

    let result = fetch(clone_repo.path(), None);
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

    let result = fetch(clone_repo.path(), None);
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
        publish_branch(repo.path(), "main", "originmain", None).is_err(),
        "missing slash must be rejected"
    );
    assert!(
        publish_branch(repo.path(), "main", "/main", None).is_err(),
        "empty remote half must be rejected"
    );
    assert!(
        publish_branch(repo.path(), "main", "origin/", None).is_err(),
        "empty branch half must be rejected"
    );
    assert!(
        publish_branch(repo.path(), "--upload-pack=x", "origin/main", None).is_err(),
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
    repo.git_ok(&["remote", "set-url", "--push", "origin", "https://github.com/old/push.git"]);

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
fn default_remote_drives_forge_even_when_listed_after_another() {
    let repo = TempRepo::new("remote-default");
    repo.git_ok(&["init", "-q"]);
    // upstream (GitLab) is added first; origin (GitHub) second. origin is the
    // default push remote, so it must win both the Remotes panel and the toolbar.
    repo.git_ok(&["remote", "add", "upstream", "https://gitlab.com/up/stream.git"]);
    repo.git_ok(&["remote", "add", "origin", "https://github.com/me/repo.git"]);

    let remotes = crate::git::read::list_remotes(repo.path()).unwrap();
    let origin = remotes.iter().find(|r| r.name == "origin").unwrap();
    assert!(origin.is_default, "origin should be the default push remote");
    assert!(!remotes.iter().find(|r| r.name == "upstream").unwrap().is_default);

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
    repo.git_ok(&["remote", "add", "upstream", "https://gitlab.com/up/stream.git"]);
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

    merge(repo.path(), "feature").expect("merge succeeds despite merge.ff=only");

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

    let result = pull(clone.path());
    assert!(result.is_err(), "divergent pull must fail, got {result:?}");

    // No rebase and no merge happened: the clone HEAD is untouched.
    let after = clone.git(&["rev-parse", "HEAD"]);
    let after_head = String::from_utf8_lossy(&after.stdout).trim().to_string();
    assert_eq!(before_head, after_head, "HEAD must be unchanged after a failed pull");
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

    pull(clone.path()).expect("fast-forward pull when strictly behind");

    let clone_head = String::from_utf8_lossy(&clone.git(&["rev-parse", "HEAD"]).stdout)
        .trim()
        .to_string();
    assert_eq!(clone_head, seed_head, "clone HEAD fast-forwarded to seed HEAD");
}
