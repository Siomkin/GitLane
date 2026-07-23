//! `files` write-path tests.

use super::support::*;

#[test]
fn write_repo_file_overwrites_and_reports_new_size() {
    let repo = repo_with_file("wrf-ok", "a.txt", b"old\n");
    let (size, state) = repo_file_lease(repo.path(), "a.txt");
    let result =
        write_repo_file(repo.path(), "a.txt", "new content\n", size, &state).expect("write ok");
    assert_eq!(result.size, "new content\n".len() as u64);
    assert_ne!(result.expected_state, state);
    assert_eq!(
        std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
        "new content\n"
    );
}

#[test]
fn write_repo_file_rejects_size_mismatch() {
    let repo = repo_with_file("wrf-size", "a.txt", b"old\n");
    let (_, state) = repo_file_lease(repo.path(), "a.txt");
    // On-disk is 4 bytes; a caller that loaded a different size (or a truncated
    // >2 MiB prefix) must be refused before the unseen remainder is destroyed.
    let err = write_repo_file(repo.path(), "a.txt", "x", 999, &state).unwrap_err();
    assert!(err.contains("changed on disk"), "unexpected: {err}");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
        "old\n"
    );
}

#[test]
fn write_repo_file_refuses_new_file() {
    let repo = repo_with_file("wrf-new", "a.txt", b"old\n");
    let (size, state) = repo_file_lease(repo.path(), "a.txt");
    // Overwrite-only: the panel never lists a nonexistent path.
    assert!(write_repo_file(repo.path(), "nope.txt", "x", size, &state).is_err());
    assert!(!repo.0.join("nope.txt").exists());
}

#[test]
fn write_repo_file_refuses_binary_content_and_binary_target() {
    let repo = repo_with_file("wrf-bin", "a.txt", b"old\n");
    let (size, state) = repo_file_lease(repo.path(), "a.txt");
    // NUL in the incoming content — scanned in full, not just the sniff window.
    assert!(write_repo_file(repo.path(), "a.txt", "a\0b", size, &state).is_err());
    let late_nul = format!("{}\0", "x".repeat(9000));
    assert!(write_repo_file(repo.path(), "a.txt", &late_nul, size, &state).is_err());
    assert_eq!(
        std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
        "old\n"
    );

    // NUL already on disk — an editor should never have offered it as text.
    let bin = repo_with_file("wrf-bin2", "b.bin", b"\0\0\0\0");
    let err = write_repo_file(bin.path(), "b.bin", "text", 4, &state).unwrap_err();
    assert!(err.contains("changed on disk"), "unexpected: {err}");
}

#[test]
fn write_repo_file_refuses_oversized_and_dotgit_paths() {
    let repo = repo_with_file("wrf-cap", "a.txt", b"old\n");
    let (size, state) = repo_file_lease(repo.path(), "a.txt");
    // A file larger than the read cap could only have been read as a prefix.
    let big = repo.0.join("big.txt");
    std::fs::write(&big, vec![b'x'; 2 * 1024 * 1024 + 1]).unwrap();
    let err = write_repo_file(repo.path(), "big.txt", "x", size, &state).unwrap_err();
    assert!(err.contains("too large"), "unexpected: {err}");

    // Incoming content is capped too — a small file can't be grown past the cap.
    let huge = "x".repeat(2 * 1024 * 1024 + 1);
    let err = write_repo_file(repo.path(), "a.txt", &huge, size, &state).unwrap_err();
    assert!(err.contains("too large"), "unexpected: {err}");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
        "old\n"
    );

    // The raw IPC surface must not be pointed at repository metadata.
    assert!(write_repo_file(repo.path(), ".git/config", "x", size, &state).is_err());
    assert!(write_repo_file(repo.path(), ".GIT/config", "x", size, &state).is_err());
}

#[test]
fn write_repo_file_leaves_original_intact_and_preserves_mode() {
    let repo = repo_with_file("wrf-atomic", "a.sh", b"#!/bin/sh\necho hi\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(repo.0.join("a.sh"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        let before = std::fs::metadata(repo.0.join("a.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let (size, state) = repo_file_lease(repo.path(), "a.sh");
        write_repo_file(repo.path(), "a.sh", "#!/bin/sh\necho bye\n", size, &state)
            .expect("write ok");
        let after = std::fs::metadata(repo.0.join("a.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            before, after,
            "executable bit must survive the atomic replace"
        );
    }
    assert_eq!(
        std::fs::read_to_string(repo.0.join("a.sh")).unwrap(),
        "#!/bin/sh\necho bye\n"
    );
    // No temp files should be left behind in the worktree.
    let leftovers: Vec<_> = std::fs::read_dir(&repo.0)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains("gitlane-tmp"))
        .collect();
    assert!(leftovers.is_empty(), "atomic write left a temp file behind");
}

#[test]
fn write_repo_file_rejects_traversal_and_symlink() {
    let repo = repo_with_file("wrf-guard", "a.txt", b"old\n");
    let (size, state) = repo_file_lease(repo.path(), "a.txt");
    assert!(write_repo_file(repo.path(), "../escape.txt", "x", size, &state).is_err());
    assert!(write_repo_file(repo.path(), "/etc/hosts", "x", size, &state).is_err());

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;

        symlink("a.txt", repo.0.join("link.txt")).unwrap();
        // A symlink is not a regular file — refuse rather than follow it.
        assert!(write_repo_file(repo.path(), "link.txt", "x", size, &state).is_err());

        let outside = repo.0.with_extension("editor-outside");
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("target.txt"), "outside\n").unwrap();
        symlink(&outside, repo.0.join("ancestor-link")).unwrap();
        assert!(write_repo_file(
            repo.path(),
            "ancestor-link/target.txt",
            "changed\n",
            8,
            &state
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(outside.join("target.txt")).unwrap(),
            "outside\n"
        );
        let _ = std::fs::remove_dir_all(&outside);
    }
}

#[test]
fn write_repo_file_rejects_same_size_external_edit() {
    let repo = repo_with_file("wrf-same-size", "a.txt", b"old\n");
    let (size, state) = repo_file_lease(repo.path(), "a.txt");
    std::fs::write(repo.0.join("a.txt"), b"new\n").unwrap();

    let err = write_repo_file(repo.path(), "a.txt", "mine\n", size, &state).unwrap_err();
    assert!(
        err.contains("contents or file identity"),
        "unexpected: {err}"
    );
    assert_eq!(std::fs::read(repo.0.join("a.txt")).unwrap(), b"new\n");
}

#[test]
fn write_repo_file_rejects_identical_atomic_replacement_after_read() {
    let repo = repo_with_file("wrf-replaced-before", "a.txt", b"old\n");
    let (size, state) = repo_file_lease(repo.path(), "a.txt");
    let replacement = repo.0.join("replacement.txt");
    std::fs::write(&replacement, b"old\n").unwrap();
    std::fs::rename(replacement, repo.0.join("a.txt")).unwrap();

    let err = write_repo_file(repo.path(), "a.txt", "mine\n", size, &state).unwrap_err();
    assert!(err.contains("file identity"), "unexpected: {err}");
    assert_eq!(std::fs::read(repo.0.join("a.txt")).unwrap(), b"old\n");
}

#[test]
fn write_repo_file_rechecks_leaf_identity_immediately_before_rename() {
    let repo = repo_with_file("wrf-replaced-during", "a.txt", b"old\n");
    let (size, state) = repo_file_lease(repo.path(), "a.txt");
    let target = repo.0.join("a.txt");
    set_before_replace_test_hook(move || {
        let replacement = target.with_extension("replacement");
        std::fs::write(&replacement, b"other\n").unwrap();
        std::fs::rename(replacement, target).unwrap();
    });

    let err = write_repo_file(repo.path(), "a.txt", "mine\n", size, &state).unwrap_err();
    assert!(err.contains("changed while"), "unexpected: {err}");
    assert_eq!(std::fs::read(repo.0.join("a.txt")).unwrap(), b"other\n");
}

#[test]
fn write_repo_file_refuses_a_lease_when_published_inode_is_replaced() {
    let repo = repo_with_file("wrf-replaced-after", "a.txt", b"old\n");
    let (size, state) = repo_file_lease(repo.path(), "a.txt");
    let target = repo.0.join("a.txt");
    set_after_guarded_rename_test_hook(move || {
        let replacement = target.with_extension("external");
        std::fs::write(&replacement, b"external\n").unwrap();
        std::fs::rename(replacement, target).unwrap();
    });

    let err = write_repo_file(repo.path(), "a.txt", "mine\n", size, &state).unwrap_err();
    assert!(err.contains("changed while"), "unexpected: {err}");
    assert_eq!(std::fs::read(repo.0.join("a.txt")).unwrap(), b"external\n");
}

#[test]
fn write_repo_file_returns_the_lease_for_a_sequential_save() {
    let repo = repo_with_file("wrf-sequential", "a.txt", b"zero\n");
    let (size, state) = repo_file_lease(repo.path(), "a.txt");
    let first = write_repo_file(repo.path(), "a.txt", "one\n", size, &state).expect("first save");
    let second = write_repo_file(
        repo.path(),
        "a.txt",
        "two\n",
        first.size,
        &first.expected_state,
    )
    .expect("second save uses returned lease");
    assert_eq!(second.size, 4);
    assert_eq!(std::fs::read(repo.0.join("a.txt")).unwrap(), b"two\n");
}

#[test]
fn write_repo_file_rejects_missing_and_malformed_state_tokens() {
    let repo = repo_with_file("wrf-token-format", "a.txt", b"old\n");
    assert!(write_repo_file(repo.path(), "a.txt", "mine\n", 4, "")
        .unwrap_err()
        .contains("missing file state token"));
    assert!(
        write_repo_file(repo.path(), "a.txt", "mine\n", 4, "v1:not-this-domain")
            .unwrap_err()
            .contains("invalid file state token")
    );
    assert_eq!(std::fs::read(repo.0.join("a.txt")).unwrap(), b"old\n");
}

#[test]
fn write_repo_file_state_cannot_be_replayed_across_worktrees_or_nested_repos() {
    let repo = repo_with_file("wrf-token-scope", "a.txt", b"same\n");
    let (size, state) = repo_file_lease(repo.path(), "a.txt");

    let linked = repo.0.with_extension("linked-worktree");
    let _ = std::fs::remove_dir_all(&linked);
    let linked_path = linked.to_string_lossy().into_owned();
    repo.git_ok(&["worktree", "add", "-q", "-b", "linked", &linked_path]);
    let linked_err = write_repo_file(&linked_path, "a.txt", "mine\n", size, &state).unwrap_err();
    assert!(
        linked_err.contains("file identity"),
        "unexpected: {linked_err}"
    );

    let nested = repo.0.join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    git_ok_at(&nested, &["init", "-q", "-b", "main"]);
    git_ok_at(&nested, &["config", "user.name", "GitLane Test"]);
    git_ok_at(&nested, &["config", "user.email", "gitlane@example.test"]);
    std::fs::write(nested.join("a.txt"), b"same\n").unwrap();
    git_ok_at(&nested, &["add", "a.txt"]);
    git_ok_at(&nested, &["commit", "-q", "-m", "seed"]);
    let nested_path = nested.to_string_lossy().into_owned();
    let nested_err = write_repo_file(&nested_path, "a.txt", "mine\n", size, &state).unwrap_err();
    assert!(
        nested_err.contains("file identity"),
        "unexpected: {nested_err}"
    );

    repo.git_ok(&["worktree", "remove", "--force", &linked_path]);
}

/// Every `LeaseError` variant, rendered by both operations, pinned to its exact
/// text.
///
/// The shared primitives report a typed failure and each module words it, so the
/// wording is now the thing a refactor can quietly break — and it breaks
/// silently: swapping two arms leaves both strings present in the tree, so a
/// "no literal changed" check still passes. Substring assertions elsewhere in
/// this file would not catch it either. Hence exact strings, both renderers,
/// every variant (GL-332).
#[test]
fn lease_errors_render_in_each_operations_own_words() {
    use crate::git::write::state_lease::LeaseError;

    let cases: Vec<(LeaseError, LeaseError, &str, &str)> = vec![
        (
            LeaseError::WorkdirNotUtf8,
            LeaseError::WorkdirNotUtf8,
            "Cannot run Discard all from a worktree path that is not valid UTF-8.",
            "Cannot lease a hard reset from a worktree path that is not valid UTF-8.",
        ),
        (
            LeaseError::OpenRepository(git2::Error::from_str("boom")),
            LeaseError::OpenRepository(git2::Error::from_str("boom")),
            "Could not inspect the repository before discarding: boom",
            "Could not inspect the repository before hard reset: boom",
        ),
        (
            LeaseError::BareRepository,
            LeaseError::BareRepository,
            "Cannot discard changes in a bare repository.",
            "Cannot hard-reset a bare repository.",
        ),
        (
            LeaseError::NonUtf8GitPath,
            LeaseError::NonUtf8GitPath,
            "Discard all cannot safely represent a non-UTF-8 Git path on this platform.",
            "Hard reset cannot safely represent a non-UTF-8 Git path on this platform.",
        ),
        (
            LeaseError::ReplaceRefsActive,
            LeaseError::ReplaceRefsActive,
            "Discard all is unavailable while Git replacement refs are active. Remove the replacement refs or use the terminal.",
            "Hard reset is unavailable while Git replacement refs are active. Remove the replacement refs or use the terminal.",
        ),
        (
            LeaseError::InspectHead(git2::Error::from_str("boom")),
            LeaseError::InspectHead(git2::Error::from_str("boom")),
            "Could not inspect HEAD before discarding: boom",
            "Could not inspect HEAD before hard reset: boom",
        ),
        (
            LeaseError::ResolveHead(git2::Error::from_str("boom")),
            LeaseError::ResolveHead(git2::Error::from_str("boom")),
            "Could not resolve HEAD before discarding: boom",
            "Could not resolve HEAD before hard reset: boom",
        ),
        (
            LeaseError::NonFileWorktreePath {
                label: "sub".to_string(),
                kind: 4,
                mode: 0o40755,
            },
            LeaseError::NonFileWorktreePath {
                label: "sub".to_string(),
                kind: 4,
                mode: 0o40755,
            },
            "Refusing to discard non-file worktree path sub (type 4, mode 40755). Move the directory or nested repository aside and try again.",
            "Refusing to hard-reset while non-file worktree path sub is present (type 4, mode 40755). Move it aside and try again.",
        ),
        (
            // Shared text: both operations must render it identically.
            LeaseError::Worded("Could not resolve the repository worktree: boom".to_string()),
            LeaseError::Worded("Could not resolve the repository worktree: boom".to_string()),
            "Could not resolve the repository worktree: boom",
            "Could not resolve the repository worktree: boom",
        ),
    ];

    for (discard_error, hard_error, discard_text, hard_text) in cases {
        assert_eq!(
            super::super::discard_all::describe_lease_error(discard_error),
            discard_text
        );
        assert_eq!(
            super::super::hard_reset_lease::describe_lease_error(hard_error),
            hard_text
        );
    }
}
