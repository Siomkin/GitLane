//! Drift a hard reset must reject before mutating anything: worktree, index,
//! HEAD, and observations revalidated after the content pass.

use super::super::support::*;

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
