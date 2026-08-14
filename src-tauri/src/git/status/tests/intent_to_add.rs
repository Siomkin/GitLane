//! Intent-to-add entries: staged or not, how they promote, and what their diff
//! shows (GL-114).

use super::support::*;

#[test]
fn intent_to_add_file_is_unstaged_not_staged() {
    let dir = std::env::temp_dir().join("gitlane-intent-to-add-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");

    // Use the real `git add -N` so the index entry lands exactly as git
    // records it — that on-disk shape is what the classification must handle.
    fs::write(dir.join("planned.txt"), "alpha\nbeta\n").unwrap();
    let status = std::process::Command::new("git")
        .args(["add", "--intent-to-add", "planned.txt"])
        .current_dir(&dir)
        .status()
        .unwrap();
    assert!(status.success());

    let changes = working_changes(dir.to_str().unwrap()).unwrap();
    // git treats intent-to-add as unstaged (` A` in porcelain, empty
    // `git diff --cached`, `git commit` refuses) — it must not show as staged.
    assert!(
        changes.staged.iter().all(|f| f.path != "planned.txt"),
        "intent-to-add leaked into staged: {:?}",
        changes
            .staged
            .iter()
            .map(|f| (&f.path, &f.status))
            .collect::<Vec<_>>()
    );
    let entry = changes
        .unstaged
        .iter()
        .find(|f| f.path == "planned.txt")
        .expect("intent-to-add file appears in the unstaged bucket");
    assert_eq!(entry.status, "A");
    assert_eq!(entry.add, 2);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn empty_intent_to_add_file_is_unstaged() {
    let dir = std::env::temp_dir().join("gitlane-ita-empty-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");

    // An *empty* intent-to-add file: libgit2 sets INDEX_NEW with no WT flag
    // (identical empty content), so this exercises the branch where the
    // unstaged status is otherwise None and must be forced to "A". git shows
    // ` A empty.txt` in porcelain.
    fs::write(dir.join("empty.txt"), "").unwrap();
    assert!(std::process::Command::new("git")
        .args(["add", "--intent-to-add", "empty.txt"])
        .current_dir(&dir)
        .status()
        .unwrap()
        .success());

    let changes = working_changes(dir.to_str().unwrap()).unwrap();
    assert!(changes.staged.iter().all(|f| f.path != "empty.txt"));
    let entry = changes
        .unstaged
        .iter()
        .find(|f| f.path == "empty.txt")
        .expect("empty intent-to-add file appears as an unstaged add");
    assert_eq!(entry.status, "A");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn intent_to_add_then_deleted_shows_unstaged_delete() {
    let dir = std::env::temp_dir().join("gitlane-ita-then-delete-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");

    fs::write(dir.join("planned.txt"), "x\ny\n").unwrap();
    assert!(std::process::Command::new("git")
        .args(["add", "--intent-to-add", "planned.txt"])
        .current_dir(&dir)
        .status()
        .unwrap()
        .success());
    // Remove the file again after recording the intent: git reports ` D` (a
    // plain unstaged deletion), not a pending add — the worktree deletion wins.
    fs::remove_file(dir.join("planned.txt")).unwrap();

    let changes = working_changes(dir.to_str().unwrap()).unwrap();
    assert!(changes.staged.iter().all(|f| f.path != "planned.txt"));
    let entry = changes
        .unstaged
        .iter()
        .find(|f| f.path == "planned.txt")
        .expect("deleted intent-to-add file appears as an unstaged deletion");
    assert_eq!(entry.status, "D");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn intent_to_add_promotes_to_staged_after_full_add() {
    let dir = std::env::temp_dir().join("gitlane-ita-promote-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");

    fs::write(dir.join("promo.txt"), "a\nb\n").unwrap();
    let git = |args: &[&str]| {
        assert!(std::process::Command::new("git")
            .args(args)
            .current_dir(&dir)
            .status()
            .unwrap()
            .success());
    };
    git(&["add", "--intent-to-add", "promo.txt"]);
    git(&["add", "promo.txt"]); // full add promotes it out of intent-to-add

    // Once the content is really staged, the entry is a normal add (real blob
    // oid, no intent-to-add flag) and belongs in the staged bucket.
    let changes = working_changes(dir.to_str().unwrap()).unwrap();
    let entry = changes
        .staged
        .iter()
        .find(|f| f.path == "promo.txt")
        .expect("fully-added file promotes into the staged bucket");
    assert_eq!(entry.status, "A");
    assert!(changes.unstaged.iter().all(|f| f.path != "promo.txt"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn intent_to_add_file_diff_shows_full_content() {
    let dir = std::env::temp_dir().join("gitlane-ita-filediff-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let repo = Repository::init(&dir).unwrap();
    commit(&repo, &dir, "seed.txt", "seed\n");

    fs::write(dir.join("planned.txt"), "alpha\nbeta\ngamma\n").unwrap();
    let status = std::process::Command::new("git")
        .args(["add", "--intent-to-add", "planned.txt"])
        .current_dir(&dir)
        .status()
        .unwrap();
    assert!(status.success());

    // The review pane requests the unstaged diff; git shows the whole file as an
    // add (`git diff` = full "new file" hunk). The per-file diff must carry that
    // content, not come back empty.
    let diff = file_diff(dir.to_str().unwrap(), "planned.txt", false, false).unwrap();
    let adds: Vec<&str> = diff
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter(|l| l.kind == "add")
        .map(|l| l.content.as_str())
        .collect();
    assert_eq!(adds, vec!["alpha", "beta", "gamma"]);

    let _ = fs::remove_dir_all(&dir);
}
