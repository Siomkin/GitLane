//! Which working tree a reset actually mutates: linked-worktree scope,
//! gitfile retargets, and close/reopen ABA cycles.

use super::super::support::*;

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
    // The staged copy is taken before the removal so the recreated workdir is
    // guaranteed a different inode: git's own remove/add cycle can be handed the
    // freed one straight back (see `StagedDirReplacement`).
    let replacement = StagedDirReplacement::stage(&linked.0).expect("stage the workdir");
    main.git_ok(&["worktree", "remove", "--force", linked.path()]);
    main.git_ok(&["worktree", "add", "-q", linked.path(), "feature"]);
    std::fs::write(linked.0.join("f.txt"), b"dirty\n").unwrap();
    replacement
        .apply()
        .expect("swap in a workdir with a new inode");

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
