//! Pushing a stash: what it includes, how its outcome is reported, and the
//! guards that keep a failure from adopting an unrelated entry.

use super::super::support::*;
use crate::git::types::OperationKind;

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
        OperationKind::Carry
    );

    // The carry's recovery stash disappears (finished/aborted/dropped outside the
    // app), leaving only the marker. A stale marker must self-heal to "none" and
    // not keep claiming (or later mislabel) the worktree as a carry.
    repo.git(&["stash", "clear"]);
    assert_eq!(
        crate::git::conflicts::operation_status(repo.path())
            .unwrap()
            .kind,
        OperationKind::None,
        "a marker whose stashes are gone must not report a carry"
    );
    // The marker file was swept, so a subsequent read is also clean.
    assert_eq!(
        crate::git::conflicts::operation_status(repo.path())
            .unwrap()
            .kind,
        OperationKind::None
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
