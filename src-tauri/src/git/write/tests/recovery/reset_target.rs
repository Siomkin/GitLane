//! Resolving a reset's target: the previewed oid wins over a same-named ref
//! that moved, and an inexact target is refused.

use super::super::support::*;

#[test]
fn reset_rejects_an_unknown_mode_without_resetting() {
    // The mode crosses the wire as a plain string; anything but the three
    // known modes must fail the request, not degrade to a mixed reset while
    // the UI reports the mode the user picked.
    let repo = TempRepo::new("reset-unknown-mode");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "one"]);
    let first = rev_parse(&repo, "HEAD");
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "two"]);
    let second = rev_parse(&repo, "HEAD");

    let error = ResetRequest::parse(Some("main"), Some(&second), "fold", None, None, None)
        .expect_err("an unknown mode must be rejected, not degraded to mixed");
    assert!(error.contains("\"fold\""), "unexpected error: {error}");
    assert_eq!(
        rev_parse(&repo, "HEAD"),
        second,
        "no reset may run for a rejected mode — {first} must not be checked out"
    );
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
        &preview.target_oid,
        ResetRequest::parse(
            Some("main"),
            preview.expected_source_oid.as_deref(),
            "hard",
            preview.expected_state.as_deref(),
            preview.expected_head_branch.as_deref(),
            preview.expected_head_oid.as_deref(),
        )
        .expect("valid reset request"),
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
        &preview.target_oid,
        ResetRequest::parse(
            Some("main"),
            preview.expected_source_oid.as_deref(),
            "hard",
            preview.expected_state.as_deref(),
            preview.expected_head_branch.as_deref(),
            preview.expected_head_oid.as_deref(),
        )
        .expect("valid reset request"),
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
        &first,
        ResetRequest::parse(Some("main"), Some(&second), "mixed", None, None, None)
            .expect("valid reset request"),
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
        "target-ref",
        ResetRequest::parse(
            Some("main"),
            preview.expected_source_oid.as_deref(),
            "mixed",
            None,
            None,
            None,
        )
        .expect("valid reset request"),
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
        &preview.target_oid,
        ResetRequest::parse(
            Some("main"),
            preview.expected_source_oid.as_deref(),
            "hard",
            preview.expected_state.as_deref(),
            preview.expected_head_branch.as_deref(),
            preview.expected_head_oid.as_deref(),
        )
        .expect("valid reset request"),
    )
    .expect_err("editing the case-colliding obstruction must expire the lease");
    assert!(
        error.contains("changed after this confirmation"),
        "unexpected error: {error}"
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
        &target,
        ResetRequest::parse(
            Some("main"),
            Some(&source),
            "hard",
            preview.expected_state.as_deref(),
            preview.expected_head_branch.as_deref(),
            preview.expected_head_oid.as_deref(),
        )
        .expect("valid reset request"),
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
