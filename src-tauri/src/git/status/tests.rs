use super::diff::DIFF_LINE_LIMIT;
use super::{
    commit_file_diff, commit_files, compare_file_diff, compare_refs, file_blame, file_diff,
    file_history, read_binary_blob, selection_diff, selection_diff_file, working_changes,
};
use git2::{Repository, Signature};
use std::fs;
use std::path::Path;

fn commit(repo: &Repository, dir: &Path, name: &str, content: &str) -> git2::Oid {
    fs::write(dir.join(name), content).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(name)).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = Signature::now("Bench", "bench@example.test").unwrap();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, name, &tree, &parents)
        .unwrap()
}

fn commit_bytes(repo: &Repository, dir: &Path, name: &str, content: &[u8]) -> git2::Oid {
    fs::write(dir.join(name), content).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(name)).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = Signature::now("Bench", "bench@example.test").unwrap();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, name, &tree, &parents)
        .unwrap()
}

fn commit_index(repo: &Repository, message: &str) -> git2::Oid {
    let mut index = repo.index().unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = Signature::now("Bench", "bench@example.test").unwrap();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .unwrap()
}

fn remove_commit(repo: &Repository, dir: &Path, name: &str) -> git2::Oid {
    fs::remove_file(dir.join(name)).unwrap();
    let mut index = repo.index().unwrap();
    index.remove_path(Path::new(name)).unwrap();
    index.write().unwrap();
    commit_index(repo, &format!("remove {name}"))
}

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

#[test]
fn file_history_lists_changes_newest_first_and_paginates() {
    let dir = std::env::temp_dir().join("gitlane-file-history-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "tracked.txt", "one\n");
    commit(&repo, &dir, "tracked.txt", "one\ntwo\n");
    fs::remove_file(dir.join("tracked.txt")).unwrap();
    let mut index = repo.index().unwrap();
    index.remove_path(Path::new("tracked.txt")).unwrap();
    index.write().unwrap();
    commit_index(&repo, "delete tracked.txt");

    let path = dir.to_str().unwrap();
    let first = file_history(path, "tracked.txt", Some(0), Some(2)).unwrap();
    assert_eq!(first.entries.len(), 2);
    assert!(first.has_more);
    assert_eq!(first.entries[0].status, "D");
    assert_eq!(first.entries[1].status, "M");

    let second = file_history(path, "tracked.txt", Some(first.next_offset), Some(2)).unwrap();
    assert_eq!(second.entries.len(), 1);
    assert!(!second.has_more);
    assert_eq!(second.entries[0].status, "A");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn file_history_follows_detected_renames_backward() {
    let dir = std::env::temp_dir().join("gitlane-file-history-rename-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "old name.txt", "same\n");

    fs::rename(dir.join("old name.txt"), dir.join("new name.txt")).unwrap();
    let mut index = repo.index().unwrap();
    index.remove_path(Path::new("old name.txt")).unwrap();
    index.add_path(Path::new("new name.txt")).unwrap();
    index.write().unwrap();
    commit_index(&repo, "rename file");

    let page = file_history(dir.to_str().unwrap(), "new name.txt", None, Some(10)).unwrap();
    assert_eq!(page.entries.len(), 2);
    assert_eq!(page.entries[0].status, "R");
    assert_eq!(
        page.entries[0].previous_path.as_deref(),
        Some("old name.txt")
    );
    assert_eq!(page.entries[1].path, "old name.txt");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn file_blame_returns_line_attribution() {
    let dir = std::env::temp_dir().join("gitlane-file-blame-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "blame.txt", "first\n");
    let second = commit(&repo, &dir, "blame.txt", "first\nsecond\n").to_string();

    let blame = file_blame(dir.to_str().unwrap(), "blame.txt", Some(second), Some(10)).unwrap();
    assert!(!blame.binary);
    assert_eq!(blame.lines.len(), 2);
    assert_eq!(blame.lines[0].content, "first");
    assert_eq!(blame.lines[1].content, "second");
    assert_eq!(blame.lines[1].author_name, "Bench");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn file_history_reports_line_stats() {
    let dir = std::env::temp_dir().join("gitlane-file-history-stats-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "stats.txt", "a\n");
    commit(&repo, &dir, "stats.txt", "a\nb\nc\n");

    let page = file_history(dir.to_str().unwrap(), "stats.txt", None, Some(10)).unwrap();
    assert_eq!(page.entries.len(), 2);
    // Newest commit appended two lines.
    assert_eq!(page.entries[0].add, 2);
    assert_eq!(page.entries[0].del, 0);
    // The original commit added the file's first line.
    assert_eq!(page.entries[1].add, 1);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn compare_refs_lists_changed_files_with_counts_and_distance() {
    let dir = std::env::temp_dir().join("gitlane-compare-refs-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    let base = commit(&repo, &dir, "kept.txt", "one\n").to_string();
    commit(&repo, &dir, "kept.txt", "one\ntwo\n");
    let head = commit(&repo, &dir, "added.txt", "new\n").to_string();

    let path = dir.to_str().unwrap();
    let result = compare_refs(path, &base, Some(&head)).unwrap();
    let names: Vec<&str> = result.files.iter().map(|f| f.path.as_str()).collect();
    assert!(names.contains(&"kept.txt"));
    assert!(names.contains(&"added.txt"));
    assert!(result.add >= 2);
    // head is two commits past base.
    assert_eq!(result.ahead, 2);
    assert_eq!(result.behind, 0);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn compare_refs_against_working_tree() {
    let dir = std::env::temp_dir().join("gitlane-compare-working-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    let base = commit(&repo, &dir, "work.txt", "one\n").to_string();
    // Uncommitted edit in the working tree.
    fs::write(dir.join("work.txt"), "one\ntwo\n").unwrap();

    let path = dir.to_str().unwrap();
    let result = compare_refs(path, &base, None).unwrap();
    assert_eq!(result.files.len(), 1);
    assert_eq!(result.files[0].path, "work.txt");
    assert_eq!(result.ahead, 0);
    assert_eq!(result.behind, 0);

    let diff = compare_file_diff(path, &base, None, "work.txt", false).unwrap();
    assert!(diff.add >= 1);
    assert!(!diff.hunks.is_empty());

    let _ = fs::remove_dir_all(&dir);
}

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
    assert_eq!(changes.advanced.lfs.patterns, vec!["*.bin"]);
    assert!(changes
        .advanced
        .lfs
        .issues
        .iter()
        .any(|issue| issue.contains("asset.bin")));

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
    let entry = changes.unstaged.iter().find(|f| f.path == "pic.png").unwrap();
    assert!(entry.binary);

    // The single-file diff goes through the untracked fallback → a binary card
    // with the new size, no synthesized text hunks.
    let diff = file_diff(path, "pic.png", false, false).unwrap();
    assert!(diff.binary);
    assert_eq!(diff.new_size, Some(png.len() as u64));
    assert!(diff.hunks.is_empty());

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

// ---- GL-69: merged ("union") diff across a multi-commit selection ----

#[test]
fn selection_diff_nets_add_then_delete_to_nothing() {
    let dir = std::env::temp_dir().join("gitlane-selection-add-del-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");
    let add = commit(&repo, &dir, "temp.txt", "scratch\n").to_string();
    let del = remove_commit(&repo, &dir, "temp.txt").to_string();
    let path = dir.to_str().unwrap();

    // Added then deleted within the selection → the file drops out entirely.
    let files = selection_diff(path, &[add, del]).unwrap();
    assert!(
        files.iter().all(|f| f.path != "temp.txt"),
        "temp.txt should net to no change: {:?}",
        files.iter().map(|f| &f.path).collect::<Vec<_>>()
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn selection_diff_nets_add_then_modify_to_add() {
    let dir = std::env::temp_dir().join("gitlane-selection-add-mod-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");
    let add = commit(&repo, &dir, "f.txt", "one\n").to_string();
    let modify = commit(&repo, &dir, "f.txt", "one\ntwo\n").to_string();
    let path = dir.to_str().unwrap();
    let oids = [add, modify];

    // The earliest touch added the file, so the net status is "A" with the final
    // content — not "M".
    let files = selection_diff(path, &oids).unwrap();
    let entry = files.iter().find(|f| f.path == "f.txt").unwrap();
    assert_eq!(entry.status, "A");

    let diff = selection_diff_file(path, &oids, "f.txt", false).unwrap();
    assert_eq!(diff.status, "A");
    let adds: Vec<&str> = diff
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter(|l| l.kind == "add")
        .map(|l| l.content.as_str())
        .collect();
    assert_eq!(adds, vec!["one", "two"]);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn selection_diff_nets_modify_then_delete_to_delete() {
    let dir = std::env::temp_dir().join("gitlane-selection-mod-del-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "g.txt", "a\nb\n");
    let modify = commit(&repo, &dir, "g.txt", "a\nB\n").to_string();
    let del = remove_commit(&repo, &dir, "g.txt").to_string();
    let path = dir.to_str().unwrap();

    // Net from the pre-selection state ("a\nb\n") to absent → a deletion.
    let files = selection_diff(path, &[modify, del]).unwrap();
    let entry = files.iter().find(|f| f.path == "g.txt").unwrap();
    assert_eq!(entry.status, "D");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn selection_diff_unions_disjoint_commits_excluding_unselected() {
    let dir = std::env::temp_dir().join("gitlane-selection-disjoint-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");
    let a = commit(&repo, &dir, "fa.txt", "a\n").to_string();
    // fb.txt is committed *between* the two picks but left unselected.
    commit(&repo, &dir, "fb.txt", "b\n");
    let c = commit(&repo, &dir, "fc.txt", "c\n").to_string();
    let path = dir.to_str().unwrap();

    let files = selection_diff(path, &[a, c]).unwrap();
    let names: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    assert!(names.contains(&"fa.txt"));
    assert!(names.contains(&"fc.txt"));
    assert!(!names.contains(&"fb.txt"), "unselected commit must not leak in: {names:?}");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn selection_diff_handles_binary_files() {
    let dir = std::env::temp_dir().join("gitlane-selection-binary-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");
    let v1: Vec<u8> = vec![0u8, 1, 2, 0];
    let v2: Vec<u8> = vec![0u8, 9, 8, 7, 6, 0];
    let add = commit_bytes(&repo, &dir, "img.bin", &v1).to_string();
    let modify = commit_bytes(&repo, &dir, "img.bin", &v2).to_string();
    let path = dir.to_str().unwrap();
    let oids = [add, modify];

    let files = selection_diff(path, &oids).unwrap();
    let entry = files.iter().find(|f| f.path == "img.bin").unwrap();
    assert!(entry.binary);
    assert_eq!(entry.status, "A");
    assert_eq!((entry.add, entry.del), (0, 0));

    // Added then modified → still added; the binary card shows only the new side.
    let diff = selection_diff_file(path, &oids, "img.bin", false).unwrap();
    assert!(diff.binary);
    assert_eq!(diff.status, "A");
    assert_eq!(diff.new_size, Some(v2.len() as u64));
    assert_eq!(diff.old_size, None);
    assert!(diff.hunks.is_empty());

    let _ = fs::remove_dir_all(&dir);
}
