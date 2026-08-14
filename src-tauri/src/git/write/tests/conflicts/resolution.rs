//! Per-file conflict resolution: accept a side, write a resolution, reconflict,
//! and path-edge guards.

use super::super::support::*;

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
