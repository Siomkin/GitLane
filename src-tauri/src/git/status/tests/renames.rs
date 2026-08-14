//! Renames in the working tree and index: reported as one entry, staged and
//! unstaged as a pair (GL-114).

use super::support::*;

#[test]
fn unstaged_rename_is_reported_as_one_rename_entry() {
    let dir = std::env::temp_dir().join("gitlane-unstaged-rename-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(
        &repo,
        &dir,
        "original.txt",
        "one\ntwo\nthree\nfour\nfive\nsix\n",
    );

    // A pure worktree rename (no index update). Note this is NOT git-CLI
    // parity: `git status` reports this as `deleted: original.txt` plus an
    // untracked `renamed.txt` (it only detects index-side renames). We opt into
    // libgit2's index→workdir rename detection deliberately, to collapse the
    // pair into one `R` entry — the same single-rename presentation the staged
    // side already gives.
    fs::rename(dir.join("original.txt"), dir.join("renamed.txt")).unwrap();

    let changes = working_changes(dir.to_str().unwrap()).unwrap();
    assert!(changes.staged.is_empty());
    let entry = changes
        .unstaged
        .iter()
        .find(|f| f.path == "renamed.txt")
        .expect("rename detected under the new path");
    assert_eq!(entry.status, "R");
    // The entry carries the old path so staging can move both sides (GL-127).
    assert_eq!(entry.previous_path.as_deref(), Some("original.txt"));
    assert!(
        changes.unstaged.iter().all(|f| f.path != "original.txt"),
        "old path must fold into the rename, not linger as a deletion: {:?}",
        changes
            .unstaged
            .iter()
            .map(|f| (&f.path, &f.status))
            .collect::<Vec<_>>()
    );
    assert_eq!(changes.unstaged.len(), 1);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn staging_a_worktree_rename_records_a_single_rename() {
    // GL-127: a pure worktree rename surfaces as one unstaged "R" entry naming
    // the new path (GL-114). The entry must carry the old path as `previous_path`
    // so the frontend can stage both sides at once — otherwise `git add <new>`
    // stages only the addition and leaves the old path's deletion as a leftover
    // unstaged "D".
    let dir = std::env::temp_dir().join("gitlane-stage-rename-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    // Identical content on both sides → unambiguous rename detection.
    commit(&repo, &dir, "old.txt", "alpha\nbeta\ngamma\ndelta\n");
    let path = dir.to_str().unwrap();

    // Move the file on disk; the index still holds old.txt.
    fs::rename(dir.join("old.txt"), dir.join("new.txt")).unwrap();

    let before = working_changes(path).unwrap();
    assert!(
        before.staged.is_empty(),
        "nothing staged yet: {:?}",
        before.staged
    );
    assert_eq!(
        before.unstaged.len(),
        1,
        "one unstaged entry: {:?}",
        before.unstaged
    );
    let entry = &before.unstaged[0];
    assert_eq!(entry.status, "R");
    assert_eq!(entry.path, "new.txt");
    assert_eq!(entry.previous_path.as_deref(), Some("old.txt"));

    // Stage the rename the way the store's `stageFile` does for an "R": both the
    // old and new path together, atomically.
    let paths = vec![entry.previous_path.clone().unwrap(), entry.path.clone()];
    crate::git::write::staging::stage_files(path, &paths).expect("stage both sides of the rename");

    // The index now holds a single staged rename and nothing is left unstaged —
    // no orphaned "D old.txt".
    let after = working_changes(path).unwrap();
    assert_eq!(
        after.staged.len(),
        1,
        "one staged entry: {:?}",
        after.staged
    );
    assert_eq!(after.staged[0].status, "R");
    assert_eq!(after.staged[0].path, "new.txt");
    assert_eq!(after.staged[0].previous_path.as_deref(), Some("old.txt"));
    assert!(
        after.unstaged.is_empty(),
        "no leftover unstaged deletion: {:?}",
        after.unstaged
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn unstaging_a_staged_rename_restores_both_sides() {
    // GL-127 (mirror of the stage case): a staged rename carries `previous_path`,
    // and unstaging it via both paths must return the file to a single unstaged
    // "R" with no orphaned staged "D old.txt". This is the round-trip the store's
    // `unstageFile` performs.
    let dir = std::env::temp_dir().join("gitlane-unstage-rename-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "old.txt", "alpha\nbeta\ngamma\ndelta\n");
    let path = dir.to_str().unwrap();

    // Rename on disk, then stage both sides so the index holds a staged rename.
    fs::rename(dir.join("old.txt"), dir.join("new.txt")).unwrap();
    crate::git::write::staging::stage_files(path, &["old.txt".to_string(), "new.txt".to_string()])
        .expect("stage the rename");

    let staged = working_changes(path).unwrap();
    assert_eq!(
        staged.staged.len(),
        1,
        "one staged rename: {:?}",
        staged.staged
    );
    let entry = &staged.staged[0];
    assert_eq!(entry.status, "R");
    assert_eq!(entry.previous_path.as_deref(), Some("old.txt"));

    // Unstage the way the store's `unstageFile` does for an "R": both paths.
    let paths = vec![entry.previous_path.clone().unwrap(), entry.path.clone()];
    crate::git::write::staging::unstage_files(path, &paths)
        .expect("unstage both sides of the rename");

    // Back to a single unstaged rename, nothing left staged.
    let after = working_changes(path).unwrap();
    assert!(
        after.staged.is_empty(),
        "no leftover staged deletion: {:?}",
        after.staged
    );
    assert_eq!(
        after.unstaged.len(),
        1,
        "one unstaged rename: {:?}",
        after.unstaged
    );
    assert_eq!(after.unstaged[0].status, "R");
    assert_eq!(after.unstaged[0].path, "new.txt");
    assert_eq!(after.unstaged[0].previous_path.as_deref(), Some("old.txt"));

    let _ = fs::remove_dir_all(&dir);
}
