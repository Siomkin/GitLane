//! The dirty probes: the removal confirm's counts, and the cheaper flag the
//! graph's dot reads.

use super::super::support::*;

#[test]
fn worktree_dirty_state_counts_modified_and_untracked_work() {
    let repo = TempRepo::new("wt-dirty");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    std::fs::write(repo.0.join("b.txt"), "b\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-dirty");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);

    // A freshly added worktree is clean.
    let clean = worktree_dirty_state(linked.as_str()).expect("probe a clean worktree");
    assert_eq!((clean.modified, clean.untracked), (0, 0));

    // Two tracked edits plus untracked files nested in a new directory. The
    // probe must expand that directory (`--untracked-files=all`) rather than
    // collapsing it to a single entry, or the warning understates the loss.
    std::fs::write(linked.0.join("a.txt"), "changed\n").unwrap();
    std::fs::write(linked.0.join("b.txt"), "changed too\n").unwrap();
    std::fs::create_dir(linked.0.join("fresh")).unwrap();
    std::fs::write(linked.0.join("fresh/one.txt"), "1\n").unwrap();
    std::fs::write(linked.0.join("fresh/two.txt"), "2\n").unwrap();

    let dirty = worktree_dirty_state(linked.as_str()).expect("probe a dirty worktree");
    assert_eq!(
        (dirty.modified, dirty.untracked),
        (2, 2),
        "expected 2 modified and 2 untracked (directory expanded), got {dirty:?}"
    );

    // Review finding: `run_git` returns stdout and stderr combined on success,
    // so anything git writes to stderr must not be scored as a changed file.
    // Renames and conflict codes are one record each and stay counted.
    assert!(!is_porcelain_record("warning: unable to access something"));
    assert!(!is_porcelain_record("fatal: not a git repository"));
    assert!(!is_porcelain_record(""));
    assert!(!is_porcelain_record("   "));
    assert!(is_porcelain_record("?? new.txt"));
    assert!(is_porcelain_record(" M tracked.txt"));
    assert!(is_porcelain_record("R  old.txt -> new.txt"));
    assert!(is_porcelain_record("UU conflicted.txt"));
    assert!(is_porcelain_record("A  added.txt"));
    assert!(is_porcelain_record("D  deleted.txt"));

    // The probe is a read: it must not itself disturb the worktree. After the
    // lease matches, the server derives `--force` for dirty removals (GL-303).
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview dirty");
    assert!(preview.requires_force);
    assert_eq!(preview.dirty.modified, 2);
    assert_eq!(preview.dirty.untracked, 2);
    remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect("force-remove a dirty worktree");
    assert!(!linked.0.exists(), "the worktree directory should be gone");
}

#[test]
fn worktree_dirty_state_counts_ignored_entries_git_would_delete() {
    let repo = TempRepo::new("wt-ignored");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join(".gitignore"), "secret.env\nbuild/\n").unwrap();
    repo.git_ok(&["add", ".gitignore"]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-ignored");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    std::fs::write(linked.0.join("secret.env"), "TOKEN=1\n").unwrap();
    std::fs::create_dir(linked.0.join("build")).unwrap();
    for name in ["a.o", "b.o", "c.o"] {
        std::fs::write(linked.0.join("build").join(name), "x").unwrap();
    }

    let state = worktree_dirty_state(linked.as_str()).expect("probe an ignored-only worktree");
    assert_eq!(
        (state.modified, state.untracked),
        (0, 0),
        "ignored files are neither modified nor untracked: {state:?}"
    );
    // The file plus the *collapsed* build/ directory — not the three .o files
    // inside it, which `--ignored` alone deliberately does not expand.
    assert_eq!(
        state.ignored, 2,
        "expected secret.env + collapsed build/, got {state:?}"
    );

    // Git considers this worktree clean, so the unforced removal the bulk sweep
    // uses does delete those files. That is precisely why the count must be
    // reported instead of assumed to be zero.
    remove_worktree_previewed(repo.path(), linked.as_str())
        .expect("git removes an ignored-only worktree without a force");
    assert!(!linked.0.exists(), "the worktree directory should be gone");
}

#[test]
fn worktree_is_dirty_flags_real_work_but_not_ignored_files() {
    let repo = TempRepo::new("wt-is-dirty");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join(".gitignore"), "build/\n").unwrap();
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-is-dirty");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    assert!(
        !worktree_is_dirty(linked.as_str()).expect("probe a clean worktree"),
        "a freshly added worktree has no uncommitted work"
    );

    // Ignored output only: git deletes it on an unforced remove, so it must not
    // read as unsaved work.
    std::fs::create_dir(linked.0.join("build")).unwrap();
    std::fs::write(linked.0.join("build/out.o"), "x").unwrap();
    assert!(
        !worktree_is_dirty(linked.as_str()).expect("probe an ignored-only worktree"),
        "ignored entries must not dot a worktree"
    );

    // A tracked edit is work.
    std::fs::write(linked.0.join("a.txt"), "changed\n").unwrap();
    assert!(
        worktree_is_dirty(linked.as_str()).expect("probe a modified worktree"),
        "a modified tracked file is uncommitted work"
    );

    // So is an untracked file — even nested, where `--untracked-files=normal`
    // reports the collapsed directory rather than the file. One record is all
    // the answer needs, which is why the probe can afford to collapse.
    git_ok_at(&linked.0, &["checkout", "--", "a.txt"]);
    std::fs::create_dir(linked.0.join("fresh")).unwrap();
    std::fs::write(linked.0.join("fresh/note.txt"), "1\n").unwrap();
    assert!(
        worktree_is_dirty(linked.as_str()).expect("probe an untracked-only worktree"),
        "an untracked file nested in a new directory is uncommitted work"
    );

    // Staged-but-uncommitted work counts too — it is exactly what a forced
    // remove would throw away.
    std::fs::remove_dir_all(linked.0.join("fresh")).unwrap();
    std::fs::write(linked.0.join("staged.txt"), "s\n").unwrap();
    git_ok_at(&linked.0, &["add", "staged.txt"]);
    assert!(
        worktree_is_dirty(linked.as_str()).expect("probe a staged-only worktree"),
        "staged-but-uncommitted work is uncommitted work"
    );

    // A worktree whose directory is gone errors rather than answering "clean".
    // The frontend degrades that to "no dot" — a false negative, which is the
    // safe direction for a hint: it never claims work is saved when it isn't.
    std::fs::remove_dir_all(&linked.0).unwrap();
    assert!(
        worktree_is_dirty(linked.as_str()).is_err(),
        "a missing worktree directory must not report clean"
    );
}

#[test]
fn worktree_is_dirty_flags_an_unresolved_conflict() {
    let repo = TempRepo::new("wt-dirty-conflict");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "base\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);
    repo.git_ok(&["checkout", "-q", "-b", "other"]);
    std::fs::write(repo.0.join("a.txt"), "other\n").unwrap();
    repo.git_ok(&["commit", "-q", "-am", "other"]);
    repo.git_ok(&["checkout", "-q", "-"]);
    std::fs::write(repo.0.join("a.txt"), "main\n").unwrap();
    repo.git_ok(&["commit", "-q", "-am", "main"]);

    let linked = LinkedDir::new("wt-dirty-conflict");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    // Conflict inside the *linked* worktree, leaving `UU` records behind.
    let merge = git_at(&linked.0, &["merge", "other"]);
    assert!(!merge.status.success(), "the merge is expected to conflict");
    assert!(
        worktree_is_dirty(linked.as_str()).expect("probe a conflicted worktree"),
        "an unresolved conflict is uncommitted work"
    );
}
