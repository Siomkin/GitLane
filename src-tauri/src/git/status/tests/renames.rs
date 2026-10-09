//! Renames in the working tree and index: reported as one entry, staged and
//! unstaged as a pair (GL-114).

use super::support::*;
use crate::git::types::ChangeStatus;

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
    assert_eq!(entry.status, ChangeStatus::Renamed);
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
    assert_eq!(entry.status, ChangeStatus::Renamed);
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
    assert_eq!(after.staged[0].status, ChangeStatus::Renamed);
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
    assert_eq!(entry.status, ChangeStatus::Renamed);
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
    assert_eq!(after.unstaged[0].status, ChangeStatus::Renamed);
    assert_eq!(after.unstaged[0].path, "new.txt");
    assert_eq!(after.unstaged[0].previous_path.as_deref(), Some("old.txt"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_worktree_rename_diffs_against_the_old_blob_not_as_a_new_file() {
    // The file list reports an unstaged rename with the counts of the *paired*
    // diff (+0 −0 for a pure move). The single-file diff behind the review pane
    // must agree: its pathspec drops the rename source, so without rename
    // detection it would report the whole file as added — 101 added lines for a
    // file that only moved (seen on a repo whose openspec/specs/* files were all
    // relocated).
    let dir = std::env::temp_dir().join("gitlane-rename-pane-diff-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "old.txt", "a\nb\nc\nd\ne\nf\ng\nh\n");
    let path = dir.to_str().unwrap();

    // A pure move: no content change on either side.
    fs::rename(dir.join("old.txt"), dir.join("moved.txt")).unwrap();
    let moved = file_diff(path, "moved.txt", false, false).unwrap();
    assert_eq!(moved.status, ChangeStatus::Renamed);
    assert_eq!((moved.add, moved.del), (0, 0));
    assert!(
        moved.hunks.is_empty(),
        "no content changed: {:?}",
        moved.hunks
    );
    let listed = working_changes(path).unwrap();
    let row = listed
        .unstaged
        .iter()
        .find(|f| f.path == "moved.txt")
        .expect("the move is listed under its new path");
    assert_eq!((row.add, row.del), (moved.add, moved.del));

    // A move plus an edit: the counts are the edit's, against the old blob.
    fs::write(dir.join("moved.txt"), "a\nb\nc\nd\ne\nf\ng\nZZZ\n").unwrap();
    let edited = file_diff(path, "moved.txt", false, false).unwrap();
    assert_eq!(edited.status, ChangeStatus::Renamed);
    assert_eq!((edited.add, edited.del), (1, 1));
    let edited_row = working_changes(path)
        .unwrap()
        .unstaged
        .into_iter()
        .find(|f| f.path == "moved.txt")
        .expect("still listed under the new path");
    assert_eq!((edited_row.add, edited_row.del), (edited.add, edited.del));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_staged_rename_diffs_against_the_old_blob_too() {
    // Staging the move moves the mismatch, it doesn't end it: HEAD→index is
    // pathspec'd the same way, so the new path looked like a staged add ("+8 −0")
    // beside a staged row reading "R +0 −0". Both sides of the index pair.
    let dir = std::env::temp_dir().join("gitlane-staged-rename-pane-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "old.txt", "a\nb\nc\nd\ne\nf\ng\nh\n");
    let path = dir.to_str().unwrap();

    fs::rename(dir.join("old.txt"), dir.join("moved.txt")).unwrap();
    crate::git::write::staging::stage_files(
        path,
        &["old.txt".to_string(), "moved.txt".to_string()],
    )
    .expect("stage both sides");

    let staged = file_diff(path, "moved.txt", true, false).unwrap();
    assert_eq!(staged.status, ChangeStatus::Renamed);
    assert_eq!((staged.add, staged.del), (0, 0));
    assert!(
        staged.hunks.is_empty(),
        "a pure move stages no content change: {:?}",
        staged.hunks
    );
    let row = &working_changes(path).unwrap().staged[0];
    assert_eq!((row.add, row.del), (staged.add, staged.del));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn an_added_file_is_not_paired_with_an_unrelated_deletion() {
    // The probe now runs for every add, not just untracked ones. A deletion in
    // the same commit must not turn an unrelated new file into a rename: only
    // libgit2's similarity decides, and the pane must match the file list.
    let dir = std::env::temp_dir().join("gitlane-unrelated-deletion-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "doomed.txt", "nothing\nalike\nat\nall\n");
    let path = dir.to_str().unwrap();

    fs::remove_file(dir.join("doomed.txt")).unwrap();
    fs::write(dir.join("fresh.txt"), "totally\ndifferent\ncontent\nhere\n").unwrap();

    let diff = file_diff(path, "fresh.txt", false, false).unwrap();
    assert_eq!(diff.status, ChangeStatus::Untracked);
    assert_eq!((diff.add, diff.del), (4, 0));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_move_that_also_edits_the_file_is_still_one_rename_entry() {
    // libgit2 reports a move-plus-edit as WT_RENAMED | WT_MODIFIED. Reading that
    // as a plain modification loses `previous_path`, so staging the row acts on
    // the new path alone and strands the old path's deletion — the GL-127 bug,
    // reached through the edited-move door instead of the pure-move one.
    let dir = std::env::temp_dir().join("gitlane-rename-with-edit-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "old.txt", "a\nb\nc\nd\ne\nf\ng\nh\n");
    let path = dir.to_str().unwrap();

    fs::rename(dir.join("old.txt"), dir.join("moved.txt")).unwrap();
    fs::write(dir.join("moved.txt"), "a\nb\nc\nd\ne\nf\ng\nZZZ\n").unwrap();

    let before = working_changes(path).unwrap();
    assert_eq!(before.unstaged.len(), 1, "one entry: {:?}", before.unstaged);
    let entry = &before.unstaged[0];
    assert_eq!(entry.status, ChangeStatus::Renamed);
    assert_eq!(entry.path, "moved.txt");
    assert_eq!(entry.previous_path.as_deref(), Some("old.txt"));
    // The counts are the edit's, not the whole file's.
    assert_eq!((entry.add, entry.del), (1, 1));

    // Staging both sides (what the store does for an "R") leaves nothing behind,
    // and the staged row keeps the pair too.
    let paths = vec![entry.previous_path.clone().unwrap(), entry.path.clone()];
    crate::git::write::staging::stage_files(path, &paths).expect("stage both sides");
    let after = working_changes(path).unwrap();
    assert!(
        after.unstaged.is_empty(),
        "no orphaned deletion: {:?}",
        after.unstaged
    );
    assert_eq!(
        after.staged.len(),
        1,
        "one staged entry: {:?}",
        after.staged
    );
    assert_eq!(after.staged[0].status, ChangeStatus::Renamed);
    assert_eq!(after.staged[0].previous_path.as_deref(), Some("old.txt"));
    assert_eq!((after.staged[0].add, after.staged[0].del), (1, 1));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_genuinely_new_file_still_diffs_as_all_added() {
    // The rename probe must not swallow the untracked case it sits in front of.
    let dir = std::env::temp_dir().join("gitlane-untracked-still-added-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "kept.txt", "kept\n");
    let path = dir.to_str().unwrap();

    fs::write(dir.join("fresh.txt"), "one\ntwo\nthree\n").unwrap();
    let diff = file_diff(path, "fresh.txt", false, false).unwrap();
    assert_eq!(diff.status, ChangeStatus::Untracked);
    assert_eq!((diff.add, diff.del), (3, 0));
    assert_eq!(diff.hunks.len(), 1);

    let _ = fs::remove_dir_all(&dir);
}
