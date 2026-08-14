//! `discard_all`'s untracked-cleanup pass: how it batches and revalidates,
//! and what it reports when a batch fails part-way.

use super::super::support::*;

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
