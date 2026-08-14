//! Diff reads: truncation, binary detection, blob oids for previews, and the
//! pathspec literal-filename guarantee.

use super::support::*;

#[test]
fn large_commit_diff_truncates_until_full_is_requested() {
    let dir = std::env::temp_dir().join("gitlane-diff-cap-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");

    let extra = 500;
    let big: String = (0..DIFF_LINE_LIMIT + extra)
        .map(|i| format!("line {i}\n"))
        .collect();
    let oid = commit(&repo, &dir, "big.txt", &big).to_string();
    let path = dir.to_str().unwrap();

    // Default: capped at the line limit, but the +add pill keeps the real total.
    let capped = commit_file_diff(path, &oid, "big.txt", false).unwrap();
    let shown: usize = capped.hunks.iter().map(|h| h.lines.len()).sum();
    assert!(capped.truncated);
    assert!(shown <= DIFF_LINE_LIMIT, "shown {shown}");
    assert_eq!(capped.add, DIFF_LINE_LIMIT + extra);

    // "Show full diff": uncapped, every line present.
    let full = commit_file_diff(path, &oid, "big.txt", true).unwrap();
    let full_shown: usize = full.hunks.iter().map(|h| h.lines.len()).sum();
    assert!(!full.truncated);
    assert_eq!(full_shown, DIFF_LINE_LIMIT + extra);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn diff_skips_no_newline_eofnl_markers() {
    let dir = std::env::temp_dir().join("gitlane-diff-eofnl-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    // A file whose last line has no trailing newline, edited in place — libgit2
    // emits a "\ No newline at end of file" EOFNL marker pseudo-line for it.
    commit(&repo, &dir, "nonl.txt", "one\ntwo\nthree");
    let oid = commit(&repo, &dir, "nonl.txt", "one\ntwo\nTHREE").to_string();
    let path = dir.to_str().unwrap();

    let diff = commit_file_diff(path, &oid, "nonl.txt", false).unwrap();
    let lines: Vec<_> = diff.hunks.iter().flat_map(|h| &h.lines).collect();

    // The real content change is present...
    assert!(lines
        .iter()
        .any(|l| l.kind == "del" && l.content == "three"));
    assert!(lines
        .iter()
        .any(|l| l.kind == "add" && l.content == "THREE"));
    // ...and the EOFNL marker pseudo-lines are dropped (no stray rows leak in).
    let allowed = ["one", "two", "three", "THREE"];
    assert!(
        lines.iter().all(|l| allowed.contains(&l.content.as_str())),
        "unexpected line content: {:?}",
        lines.iter().map(|l| &l.content).collect::<Vec<_>>()
    );

    let _ = fs::remove_dir_all(&dir);
}

#[cfg(not(windows))]
#[test]
fn per_file_diff_reads_treat_glob_characters_as_a_literal_filename() {
    let dir = std::env::temp_dir().join(format!(
        "gitlane-literal-file-diff-test-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    let magic = "*.txt";
    fs::write(dir.join(magic), "literal base\n").unwrap();
    fs::write(dir.join("victim.txt"), "victim base\n").unwrap();
    {
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(magic)).unwrap();
        index.add_path(Path::new("victim.txt")).unwrap();
        index.write().unwrap();
    }
    let base = commit_index(&repo, "base").to_string();

    fs::write(dir.join(magic), "literal committed\n").unwrap();
    fs::write(dir.join("victim.txt"), "victim committed\n").unwrap();
    {
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(magic)).unwrap();
        index.add_path(Path::new("victim.txt")).unwrap();
        index.write().unwrap();
    }
    let head = commit_index(&repo, "both changed").to_string();
    let path = dir.to_str().unwrap();

    let commit_diff = commit_file_diff(path, &head, magic, false).unwrap();
    let range_diff = diff_range_file(path, &base, &head, magic, false).unwrap();
    let compare_diff = compare_file_diff(path, &base, Some(&head), magic, false).unwrap();
    for diff in [&commit_diff, &range_diff, &compare_diff] {
        assert_eq!(diff.path, magic);
        assert!(
            diff.hunks
                .iter()
                .flat_map(|hunk| &hunk.lines)
                .any(|line| line.content == "literal committed"),
            "literal file content missing from {diff:?}"
        );
    }

    fs::write(dir.join(magic), "literal working\n").unwrap();
    fs::write(dir.join("victim.txt"), "victim working\n").unwrap();
    let working_diff = file_diff(path, magic, false, false).unwrap();
    assert_eq!(working_diff.path, magic);
    assert!(working_diff
        .hunks
        .iter()
        .flat_map(|hunk| &hunk.lines)
        .any(|line| line.content == "literal working"));

    drop(repo);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn binary_diff_surfaces_size_oids_and_bytes() {
    let dir = std::env::temp_dir().join("gitlane-binary-diff-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");
    let path = dir.to_str().unwrap();

    // A binary blob (NUL bytes ⇒ libgit2 flags it binary) added, then modified to
    // a different size so both the size delta and both oids are exercised.
    let v1: Vec<u8> = vec![0u8, 1, 2, 3, 0, 255, 10, 0];
    let v2: Vec<u8> = vec![0u8, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 255];
    let add_oid = commit_bytes(&repo, &dir, "img.bin", &v1).to_string();
    let mod_oid = commit_bytes(&repo, &dir, "img.bin", &v2).to_string();

    // File list marks it binary instead of "+0 −0".
    let files = commit_files(path, &add_oid).unwrap();
    let entry = files.iter().find(|f| f.path == "img.bin").unwrap();
    assert!(entry.binary);
    assert_eq!((entry.add, entry.del), (0, 0));

    // Added: only the new side exists (size + oid present, old side absent).
    let added = commit_file_diff(path, &add_oid, "img.bin", false).unwrap();
    assert!(added.binary);
    assert_eq!(added.new_size, Some(v1.len() as u64));
    assert_eq!(added.old_size, None);
    assert!(added.new_oid.is_some());
    assert_eq!(added.old_oid, None);

    // Modified: both sides exist, so the card can show "old → new (±delta)".
    let modified = commit_file_diff(path, &mod_oid, "img.bin", false).unwrap();
    assert!(modified.binary);
    assert_eq!(modified.old_size, Some(v1.len() as u64));
    assert_eq!(modified.new_size, Some(v2.len() as u64));
    let new_oid = modified.new_oid.clone().unwrap();
    assert!(modified.old_oid.is_some());

    // read_binary_blob round-trips the new-side bytes for the image preview.
    use base64::Engine as _;
    let blob = read_binary_blob(path, Some(&new_oid), None, None).unwrap();
    assert!(!blob.truncated);
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(blob.base64.unwrap())
        .unwrap();
    assert_eq!(decoded, v2);

    // A cap below the blob size returns size only, no inline bytes.
    let capped = read_binary_blob(path, Some(&new_oid), None, Some(1)).unwrap();
    assert!(capped.truncated);
    assert_eq!(capped.base64, None);
    assert_eq!(capped.size, v2.len() as u64);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn commit_files_marks_gitlink_as_submodule() {
    let dir = std::env::temp_dir().join("gitlane-commit-gitlink-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");

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
    let oid = commit_index(&repo, "add gitlink").to_string();
    let path = dir.to_str().unwrap();
    let files = commit_files(path, &oid).unwrap();
    let entry = files
        .iter()
        .find(|f| f.path == "vendor/sub")
        .expect("gitlink row");
    assert_eq!(
        entry.advanced.as_ref().map(|a| a.kind.as_str()),
        Some("submodule"),
        "gitlink should be tagged for Restore hide: {entry:?}"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn text_diff_carries_blob_oids_for_content_previews() {
    let dir = std::env::temp_dir().join("gitlane-text-oid-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    let v1 = "# Title\n\nfirst\n";
    let v2 = "# Title\n\nsecond\n";
    let add_oid = commit(&repo, &dir, "README.md", v1).to_string();
    let mod_oid = commit(&repo, &dir, "README.md", v2).to_string();
    let del_oid = remove_commit(&repo, &dir, "README.md").to_string();
    let path = dir.to_str().unwrap();

    // Added: only the new side exists; sizes stay binary-only (hunks carry the text).
    let added = commit_file_diff(path, &add_oid, "README.md", false).unwrap();
    assert!(!added.binary);
    assert!(added.new_oid.is_some());
    assert_eq!(added.old_oid, None);
    assert_eq!((added.old_size, added.new_size), (None, None));

    // Modified: both sides, and the new-side oid round-trips the full file text
    // (this is what the markdown preview renders).
    let modified = commit_file_diff(path, &mod_oid, "README.md", false).unwrap();
    assert!(modified.old_oid.is_some());
    let new_oid = modified.new_oid.clone().unwrap();
    use base64::Engine as _;
    let blob = read_binary_blob(path, Some(&new_oid), None, None).unwrap();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(blob.base64.unwrap())
        .unwrap();
    assert_eq!(String::from_utf8(decoded).unwrap(), v2);

    // Deleted: no new side to preview.
    let deleted = commit_file_diff(path, &del_oid, "README.md", false).unwrap();
    assert_eq!(deleted.new_oid, None);
    assert!(deleted.old_oid.is_some());

    // Working diff (the file is untracked again after the delete commit):
    // libgit2 reports the worktree side with a *computed* hash of the file — an
    // oid that need not exist in the ODB — so the frontend must read the
    // working tree by path for unstaged diffs, not by that oid.
    fs::write(dir.join("README.md"), "# Title\n\nworking\n").unwrap();
    let working = file_diff(path, "README.md", false, false).unwrap();
    assert_eq!(working.status, "U");
    assert_eq!(working.old_oid, None);
    let blob = read_binary_blob(path, None, Some("README.md"), None).unwrap();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(blob.base64.unwrap())
        .unwrap();
    assert_eq!(String::from_utf8(decoded).unwrap(), "# Title\n\nworking\n");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_binary_blob_rejects_path_traversal() {
    let dir = std::env::temp_dir().join("gitlane-binary-traversal-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");
    let path = dir.to_str().unwrap();

    // A frontend-supplied `file` may not escape the worktree.
    assert!(read_binary_blob(path, None, Some("../escape.txt"), None).is_err());
    assert!(read_binary_blob(path, None, Some("a/../../escape.txt"), None).is_err());
    assert!(read_binary_blob(path, None, Some("/etc/hosts"), None).is_err());

    let _ = fs::remove_dir_all(&dir);
}
