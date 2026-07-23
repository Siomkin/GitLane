//! `stashes` write-path tests.

use super::support::*;

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
