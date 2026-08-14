//! Abort, continue, and skip of an in-progress conflict operation.

use super::super::support::*;

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
