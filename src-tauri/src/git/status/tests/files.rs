//! Repository file listing and the text reads behind the file picker.

use super::support::*;

#[test]
fn list_repo_files_tracks_index_untracked_ignored_and_deleted() {
    let dir = std::env::temp_dir().join("gitlane-list-files-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("src")).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "tracked.txt", "one\n");
    fs::write(dir.join("src/nested.txt"), "nested\n").unwrap();
    {
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("src/nested.txt")).unwrap();
        index.write().unwrap();
    }
    commit_index(&repo, "nested");

    // Untracked file shows up; ignored file does not; a tracked file deleted
    // from the worktree (but still in the index) is dropped.
    fs::write(dir.join("untracked.txt"), "new\n").unwrap();
    fs::write(dir.join(".gitignore"), "ignored.log\n").unwrap();
    fs::write(dir.join("ignored.log"), "noise\n").unwrap();
    fs::write(dir.join("gone.txt"), "bye\n").unwrap();
    {
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("gone.txt")).unwrap();
        index.write().unwrap();
    }
    fs::remove_file(dir.join("gone.txt")).unwrap();

    let path = dir.to_str().unwrap();
    let files = super::super::list_repo_files(path).unwrap();
    assert!(files.contains(&"tracked.txt".to_string()), "{files:?}");
    assert!(files.contains(&"src/nested.txt".to_string()), "{files:?}");
    assert!(files.contains(&"untracked.txt".to_string()), "{files:?}");
    assert!(files.contains(&".gitignore".to_string()), "{files:?}");
    assert!(!files.contains(&"ignored.log".to_string()), "{files:?}");
    assert!(!files.contains(&"gone.txt".to_string()), "{files:?}");
    // Sorted output — the frontend tree builder relies on it.
    let mut sorted = files.clone();
    sorted.sort();
    assert_eq!(files, sorted);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn list_repo_files_skips_gitlink_submodule_entries() {
    let dir = std::env::temp_dir().join("gitlane-list-gitlink-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "real.txt", "hi\n");

    // Add a gitlink (submodule commit) index entry by hand — mode 0o160000.
    {
        let mut index = repo.index().unwrap();
        let entry = git2::IndexEntry {
            ctime: git2::IndexTime::new(0, 0),
            mtime: git2::IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: 0o160000,
            uid: 0,
            gid: 0,
            file_size: 0,
            id: git2::Oid::from_str("0123456789012345678901234567890123456789").unwrap(),
            flags: 0,
            flags_extended: 0,
            path: b"vendor/sub".to_vec(),
        };
        index.add(&entry).unwrap();
        index.write().unwrap();
    }

    let files = super::super::list_repo_files(dir.to_str().unwrap()).unwrap();
    assert!(files.contains(&"real.txt".to_string()), "{files:?}");
    assert!(
        !files.contains(&"vendor/sub".to_string()),
        "gitlink listed: {files:?}"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn repo_file_text_reads_truncates_and_flags_binary() {
    let dir = std::env::temp_dir().join("gitlane-file-text-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "plain.txt", "hello\nworld\n");
    let path = dir.to_str().unwrap();

    let plain = super::super::repo_file_text(path, "plain.txt", None).unwrap();
    assert_eq!(plain.text.as_deref(), Some("hello\nworld\n"));
    assert!(!plain.truncated && !plain.binary);
    assert_eq!(plain.size, 12);
    assert!(plain.expected_state.is_some());

    // A client cap may only lower the limit; content past it is cut.
    fs::write(dir.join("big.txt"), "a".repeat(64)).unwrap();
    let capped = super::super::repo_file_text(path, "big.txt", Some(16)).unwrap();
    assert!(capped.truncated);
    assert_eq!(capped.size, 64);
    assert_eq!(capped.text.as_deref().map(|t| t.len()), Some(16));
    assert!(capped.expected_state.is_none());

    fs::write(dir.join("blob.bin"), [0u8, 159, 146, 150]).unwrap();
    let binary = super::super::repo_file_text(path, "blob.bin", None).unwrap();
    assert!(binary.binary);
    assert!(binary.text.is_none());
    assert!(binary.expected_state.is_none());

    // Displayable-but-lossy bytes and a NUL beyond Git's 8 KiB binary sniff
    // window are still never editable: no lease means the frontend cannot save
    // replacement characters or late binary data over the source bytes.
    fs::write(dir.join("invalid-utf8.txt"), [b'a', 0xff, b'b']).unwrap();
    let invalid = super::super::repo_file_text(path, "invalid-utf8.txt", None).unwrap();
    assert!(!invalid.binary && !invalid.truncated);
    assert!(invalid.text.is_some());
    assert!(invalid.expected_state.is_none());

    let mut late_nul = vec![b'x'; 9000];
    late_nul.push(0);
    fs::write(dir.join("late-nul.txt"), late_nul).unwrap();
    let late_nul = super::super::repo_file_text(path, "late-nul.txt", None).unwrap();
    assert!(!late_nul.binary && !late_nul.truncated);
    assert!(late_nul.expected_state.is_none());

    // Traversal and non-regular entries are refused.
    assert!(super::super::repo_file_text(path, "../outside.txt", None).is_err());
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;

        symlink(dir.join("plain.txt"), dir.join("link.txt")).unwrap();
        assert!(super::super::repo_file_text(path, "link.txt", None).is_err());

        let outside = dir.with_extension("viewer-outside");
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "outside secret\n").unwrap();
        symlink(&outside, dir.join("ancestor-link")).unwrap();
        assert!(super::super::repo_file_text(path, "ancestor-link/secret.txt", None).is_err());
        assert!(read_binary_blob(path, None, Some("ancestor-link/secret.txt"), None).is_err());
        let _ = fs::remove_dir_all(&outside);
    }

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn repo_file_text_rejects_growth_truncation_and_replacement_during_read() {
    use crate::git::worktree_fs::set_read_prefix_test_hook;

    let dir = std::env::temp_dir().join("gitlane-file-text-race-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "race.txt", &"x".repeat(64));
    let path = dir.to_str().unwrap();

    let file = dir.join("race.txt");
    let growing = file.clone();
    set_read_prefix_test_hook(move || {
        use std::io::Write as _;
        let mut handle = fs::OpenOptions::new().append(true).open(growing).unwrap();
        handle.write_all(b"growth").unwrap();
    });
    assert!(super::super::repo_file_text(path, "race.txt", None).is_err());

    fs::write(&file, "x".repeat(64)).unwrap();
    let truncating = file.clone();
    set_read_prefix_test_hook(move || fs::write(truncating, b"short").unwrap());
    assert!(super::super::repo_file_text(path, "race.txt", None).is_err());

    fs::write(&file, "x".repeat(64)).unwrap();
    let replacing = file.clone();
    set_read_prefix_test_hook(move || {
        let replacement = replacing.with_extension("replacement");
        fs::write(&replacement, "x".repeat(64)).unwrap();
        fs::rename(replacement, replacing).unwrap();
    });
    // This is deliberately a truncated read; display-only prefixes need the
    // same held-descriptor/path coherence as complete editable reads.
    assert!(super::super::repo_file_text(path, "race.txt", Some(16)).is_err());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn repo_file_head_text_returns_committed_baseline() {
    let dir = std::env::temp_dir().join("gitlane-file-head-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "a.txt", "one\ntwo\n");
    let path = dir.to_str().unwrap();

    // The committed content is returned even after the worktree diverges — that
    // divergence is exactly what the change gutter visualizes.
    fs::write(dir.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    assert_eq!(
        super::super::repo_file_head_text(path, "a.txt")
            .unwrap()
            .as_deref(),
        Some("one\ntwo\n"),
    );

    // Untracked / not-in-HEAD → no baseline.
    fs::write(dir.join("new.txt"), "fresh\n").unwrap();
    assert_eq!(
        super::super::repo_file_head_text(path, "new.txt").unwrap(),
        None
    );
    assert_eq!(
        super::super::repo_file_head_text(path, "missing.txt").unwrap(),
        None
    );

    // A binary blob at HEAD has no line baseline.
    commit_bytes(&repo, &dir, "blob.bin", &[0u8, 1, 2, 3]);
    assert_eq!(
        super::super::repo_file_head_text(path, "blob.bin").unwrap(),
        None
    );

    // A HEAD blob past the cap yields no baseline (would only be a prefix).
    commit_bytes(&repo, &dir, "big.txt", &vec![b'x'; 2 * 1024 * 1024 + 1]);
    assert_eq!(
        super::super::repo_file_head_text(path, "big.txt").unwrap(),
        None
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn repo_file_head_text_unborn_head_has_no_baseline() {
    // Fresh repo, no commits: HEAD is unborn, so there's nothing to diff against.
    let dir = std::env::temp_dir().join("gitlane-file-head-unborn");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Repository::init(&dir).unwrap();
    let path = dir.to_str().unwrap();
    fs::write(dir.join("a.txt"), "new\n").unwrap();
    assert_eq!(
        super::super::repo_file_head_text(path, "a.txt").unwrap(),
        None
    );
    let _ = fs::remove_dir_all(&dir);
}
