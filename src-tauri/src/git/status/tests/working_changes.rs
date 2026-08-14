//! The working-changes read: sparse checkout, LFS, submodules, gitattributes
//! limits, and untracked classification.

use super::support::*;

#[test]
fn working_changes_reports_sparse_checkout_state() {
    let dir = std::env::temp_dir().join("gitlane-sparse-checkout-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "tracked.txt", "one\n");

    let mut config = repo.config().unwrap();
    config.set_bool("core.sparseCheckout", true).unwrap();
    config.set_bool("core.sparseCheckoutCone", true).unwrap();
    fs::create_dir_all(dir.join(".git/info")).unwrap();
    fs::write(
        dir.join(".git/info/sparse-checkout"),
        "src/\n!src/generated/\n",
    )
    .unwrap();

    let changes = working_changes(dir.to_str().unwrap()).unwrap();
    assert!(changes.advanced.sparse_checkout.enabled);
    assert_eq!(
        changes.advanced.sparse_checkout.mode.as_deref(),
        Some("cone")
    );
    assert_eq!(changes.advanced.sparse_checkout.patterns[0], "src/");
    assert!(!changes.advanced.sparse_checkout.truncated);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn working_changes_flags_truncated_sparse_pattern_list() {
    let dir = std::env::temp_dir().join("gitlane-sparse-truncated-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "tracked.txt", "one\n");

    let mut config = repo.config().unwrap();
    config.set_bool("core.sparseCheckout", true).unwrap();
    fs::create_dir_all(dir.join(".git/info")).unwrap();
    // More patterns than the cap so the list is reported as a truncated prefix.
    let body: String = (0..300).map(|i| format!("dir{i}/\n")).collect();
    fs::write(dir.join(".git/info/sparse-checkout"), body).unwrap();

    let changes = working_changes(dir.to_str().unwrap()).unwrap();
    let sparse = &changes.advanced.sparse_checkout;
    assert!(sparse.enabled);
    assert!(sparse.truncated);
    assert_eq!(sparse.patterns.len(), 256);
    assert_eq!(sparse.patterns[0], "dir0/");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn working_changes_reports_lfs_state() {
    let dir = std::env::temp_dir().join("gitlane-lfs-state-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "tracked.txt", "one\n");
    fs::write(
        dir.join(".gitattributes"),
        "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    )
    .unwrap();
    fs::write(
        dir.join("asset.bin"),
        "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n",
    )
    .unwrap();

    let changes = working_changes(dir.to_str().unwrap()).unwrap();
    assert!(changes.advanced.lfs.detected);
    // Detection must always answer the install question (Some, either way) —
    // the value itself depends on whether the test host has git-lfs.
    assert!(changes.advanced.lfs.installed.is_some());
    assert_eq!(changes.advanced.lfs.patterns, vec!["*.bin"]);
    assert!(changes
        .advanced
        .lfs
        .issues
        .iter()
        .any(|issue| issue.contains("asset.bin")));

    let _ = fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn working_changes_does_not_follow_a_gitattributes_symlink() {
    use std::os::unix::fs::symlink;

    let dir = std::env::temp_dir().join("gitlane-lfs-attributes-symlink-test");
    let outside = dir.with_extension("outside-attributes");
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_file(&outside);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "tracked.txt", "one\n");
    fs::write(&outside, "*.bin filter=lfs diff=lfs merge=lfs -text\n").unwrap();
    symlink(&outside, dir.join(".gitattributes")).unwrap();

    let changes = working_changes(dir.to_str().unwrap()).unwrap();

    assert!(changes.advanced.lfs.patterns.is_empty());
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_file(&outside);
}

#[test]
fn working_changes_ignores_oversized_gitattributes() {
    let dir = std::env::temp_dir().join("gitlane-lfs-attributes-size-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "tracked.txt", "one\n");
    fs::write(
        dir.join(".gitattributes"),
        vec![b'x'; MAX_GITATTRIBUTES_BYTES + 1],
    )
    .unwrap();

    let changes = working_changes(dir.to_str().unwrap()).unwrap();

    assert!(changes.advanced.lfs.patterns.is_empty());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn working_changes_does_not_warn_for_unused_lfs_patterns() {
    let dir = std::env::temp_dir().join("gitlane-lfs-unused-pattern-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    fs::write(
        dir.join(".gitattributes"),
        "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    )
    .unwrap();
    commit(
        &repo,
        &dir,
        ".gitattributes",
        "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    );
    commit(&repo, &dir, "regular.txt", "one\n");
    fs::write(dir.join("regular.txt"), "one\ntwo\n").unwrap();

    let changes = working_changes(dir.to_str().unwrap()).unwrap();
    assert!(changes.advanced.lfs.detected);
    assert!(changes.advanced.lfs.issues.is_empty());
    assert!(changes.advanced.lfs.issues.is_empty());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn working_changes_ignores_unrelated_lfs_pointer_files() {
    let dir = std::env::temp_dir().join("gitlane-lfs-unrelated-pointer-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    fs::write(
        dir.join(".gitattributes"),
        "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    )
    .unwrap();
    commit(
        &repo,
        &dir,
        ".gitattributes",
        "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    );
    commit(&repo, &dir, "regular.txt", "one\n");
    fs::write(dir.join("regular.txt"), "one\ntwo\n").unwrap();
    fs::write(
        dir.join("note.txt"),
        "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n",
    )
    .unwrap();

    let changes = working_changes(dir.to_str().unwrap()).unwrap();
    assert!(changes.advanced.lfs.detected);
    assert!(changes.advanced.lfs.issues.is_empty());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn working_changes_reports_submodule_state() {
    let child_dir = std::env::temp_dir().join("gitlane-submodule-child-test");
    let parent_dir = std::env::temp_dir().join("gitlane-submodule-parent-test");
    let _ = fs::remove_dir_all(&child_dir);
    let _ = fs::remove_dir_all(&parent_dir);
    fs::create_dir_all(&child_dir).unwrap();
    fs::create_dir_all(&parent_dir).unwrap();
    let child = Repository::init(&child_dir).unwrap();
    commit(&child, &child_dir, "child.txt", "one\n");
    let parent = Repository::init(&parent_dir).unwrap();
    commit(&parent, &parent_dir, "parent.txt", "one\n");

    let url = child_dir.to_string_lossy().to_string();
    {
        let mut submodule = parent
            .submodule(&url, Path::new("deps/child"), true)
            .unwrap();
        fs::remove_dir_all(parent_dir.join("deps/child")).unwrap();
        Repository::clone(&url, parent_dir.join("deps/child")).unwrap();
        submodule.add_to_index(false).unwrap();
        submodule.add_finalize().unwrap();
    }

    let changes = working_changes(parent_dir.to_str().unwrap()).unwrap();
    assert_eq!(changes.advanced.submodules.len(), 1);
    assert_eq!(changes.advanced.submodules[0].path, "deps/child");
    assert!(changes.advanced.submodules[0].dirty);

    let _ = fs::remove_dir_all(&child_dir);
    let _ = fs::remove_dir_all(&parent_dir);
}

#[test]
fn working_changes_does_not_guard_clean_submodules() {
    let child_dir = std::env::temp_dir().join("gitlane-clean-submodule-child-test");
    let parent_dir = std::env::temp_dir().join("gitlane-clean-submodule-parent-test");
    let _ = fs::remove_dir_all(&child_dir);
    let _ = fs::remove_dir_all(&parent_dir);
    fs::create_dir_all(&child_dir).unwrap();
    fs::create_dir_all(&parent_dir).unwrap();
    let child = Repository::init(&child_dir).unwrap();
    commit(&child, &child_dir, "child.txt", "one\n");
    let parent = Repository::init(&parent_dir).unwrap();
    commit(&parent, &parent_dir, "parent.txt", "one\n");

    let url = child_dir.to_string_lossy().to_string();
    {
        let mut submodule = parent
            .submodule(&url, Path::new("deps/child"), true)
            .unwrap();
        fs::remove_dir_all(parent_dir.join("deps/child")).unwrap();
        Repository::clone(&url, parent_dir.join("deps/child")).unwrap();
        submodule.add_to_index(false).unwrap();
        submodule.add_finalize().unwrap();
    }
    commit_index(&parent, "add submodule");
    fs::write(parent_dir.join("parent.txt"), "one\ntwo\n").unwrap();

    let changes = working_changes(parent_dir.to_str().unwrap()).unwrap();
    assert_eq!(changes.advanced.submodules.len(), 1);
    assert_eq!(changes.advanced.submodules[0].status, "clean");
    assert!(!changes.advanced.submodules[0].dirty);

    let _ = fs::remove_dir_all(&child_dir);
    let _ = fs::remove_dir_all(&parent_dir);
}

#[test]
fn untracked_binary_file_is_flagged_in_working_changes() {
    let dir = std::env::temp_dir().join("gitlane-binary-untracked-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");

    // An untracked file with a NUL byte — libgit2 hasn't examined its content, so
    // the working-changes probe is what classifies it as binary.
    fs::write(dir.join("blob.bin"), [0u8, 1, 2, 0, 3]).unwrap();
    let changes = working_changes(dir.to_str().unwrap()).unwrap();
    let entry = changes
        .unstaged
        .iter()
        .find(|f| f.path == "blob.bin")
        .unwrap();
    assert!(entry.binary);
    assert_eq!((entry.add, entry.del), (0, 0));

    // read_binary_blob reads the working-tree file by path (no oid for an
    // untracked blob), so the preview still works.
    let blob = read_binary_blob(dir.to_str().unwrap(), None, Some("blob.bin"), None).unwrap();
    assert_eq!(blob.size, 5);
    assert!(blob.base64.is_some());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn large_untracked_text_count_is_marked_as_a_lower_bound() {
    let dir = std::env::temp_dir().join("gitlane-large-untracked-count-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");

    // Cross the 1 MiB working-status probe without embedding a NUL byte. The
    // returned count covers only that prefix and must never look exact.
    let line = "0123456789abcdef\n";
    fs::write(dir.join("large.txt"), line.repeat(70_000)).unwrap();
    let changes = working_changes(dir.to_str().unwrap()).unwrap();
    let entry = changes
        .unstaged
        .iter()
        .find(|f| f.path == "large.txt")
        .unwrap();
    assert!(!entry.binary);
    assert!(entry.add > 0);
    assert!(entry.line_count_truncated);
    assert!(entry.add < 70_000);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn untracked_image_is_flagged_binary_and_previewable() {
    let dir = std::env::temp_dir().join("gitlane-binary-image-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");
    let path = dir.to_str().unwrap();

    // A real PNG header (signature + IHDR) — like git, the probe flags it binary
    // off the embedded NUL bytes, so this covers the "real image" untracked case,
    // not just a synthetic NUL blob.
    let png: &[u8] =
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x02\x00\x00\x00\x02\x08\x02\x00\x00\x00";
    fs::write(dir.join("pic.png"), png).unwrap();

    let changes = working_changes(path).unwrap();
    let entry = changes
        .unstaged
        .iter()
        .find(|f| f.path == "pic.png")
        .unwrap();
    assert!(entry.binary);

    // The single-file diff goes through the untracked fallback → a binary card
    // with the new size, no synthesized text hunks.
    let diff = file_diff(path, "pic.png", false, false).unwrap();
    assert!(diff.binary);
    assert_eq!(diff.new_size, Some(png.len() as u64));
    assert!(diff.hunks.is_empty());

    let _ = fs::remove_dir_all(&dir);
}
