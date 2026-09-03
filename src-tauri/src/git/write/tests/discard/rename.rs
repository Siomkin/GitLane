//! Single-path `discard` across a rename pair, and the staged/unstaged side
//! selection that goes with it.

use super::super::support::*;

#[test]
fn discard_file_restores_both_sides_of_unstaged_and_staged_renames() {
    for staged in [false, true] {
        let repo = repo_with_file(
            if staged {
                "discard-staged-rename"
            } else {
                "discard-unstaged-rename"
            },
            "old.txt",
            b"original\n",
        );
        if staged {
            repo.git_ok(&["mv", "old.txt", "new.txt"]);
        } else {
            std::fs::rename(repo.0.join("old.txt"), repo.0.join("new.txt")).unwrap();
        }

        discard_current(&repo, "new.txt", Some("old.txt"), staged)
            .expect("discard both rename sides");

        assert_eq!(
            std::fs::read(repo.0.join("old.txt")).unwrap(),
            b"original\n"
        );
        assert!(!repo.0.join("new.txt").exists());
        assert!(
            String::from_utf8_lossy(&repo.git(&["status", "--porcelain"]).stdout)
                .trim()
                .is_empty()
        );
    }
}

#[test]
fn discard_file_preserves_staged_content_when_discarding_an_unstaged_rename() {
    let repo = repo_with_file("discard-partially-staged-rename", "old.txt", b"original\n");
    std::fs::write(repo.0.join("old.txt"), b"staged edit\n").unwrap();
    repo.git_ok(&["add", "old.txt"]);
    std::fs::rename(repo.0.join("old.txt"), repo.0.join("new.txt")).unwrap();

    discard_current(&repo, "new.txt", Some("old.txt"), false)
        .expect("discard only the worktree rename");

    assert_eq!(
        std::fs::read(repo.0.join("old.txt")).unwrap(),
        b"staged edit\n"
    );
    assert!(!repo.0.join("new.txt").exists());
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["show", ":old.txt"]).stdout),
        "staged edit\n"
    );
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["status", "--porcelain=v1"]).stdout),
        "M  old.txt\n"
    );
}

#[test]
fn discard_file_handles_a_case_only_staged_rename() {
    let repo = repo_with_file("discard-case-only-rename", "case.txt", b"original\n");
    repo.git_ok(&["mv", "case.txt", "case-intermediate.txt"]);
    repo.git_ok(&["mv", "case-intermediate.txt", "CASE.txt"]);

    discard_current(&repo, "CASE.txt", Some("case.txt"), true)
        .expect("discard the case-only rename");

    assert_eq!(
        std::fs::read(repo.0.join("case.txt")).unwrap(),
        b"original\n"
    );
    let worktree_names: Vec<_> = std::fs::read_dir(&repo.0)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name())
        .collect();
    assert!(worktree_names.iter().any(|name| name == "case.txt"));
    assert!(!worktree_names.iter().any(|name| name == "CASE.txt"));
    assert!(
        String::from_utf8_lossy(&repo.git(&["status", "--porcelain=v1"]).stdout)
            .trim()
            .is_empty()
    );
}

#[test]
fn discard_file_refuses_a_stale_rename_pair_before_mutating_either_path() {
    for staged in [false, true] {
        let repo = repo_with_file(
            if staged {
                "discard-stale-staged-rename"
            } else {
                "discard-stale-unstaged-rename"
            },
            "old.txt",
            b"old base\n",
        );
        std::fs::write(repo.0.join("new.txt"), b"new base\n").unwrap();
        repo.git_ok(&["add", "new.txt"]);
        repo.git_ok(&["commit", "-q", "-m", "track both paths"]);
        std::fs::write(repo.0.join("old.txt"), b"precious old edit\n").unwrap();
        std::fs::write(repo.0.join("new.txt"), b"precious new edit\n").unwrap();
        if staged {
            repo.git_ok(&["add", "old.txt", "new.txt"]);
        }
        let before_status = repo.git(&["status", "--porcelain=v1", "-z"]);
        let before_index = repo.git(&["diff", "--cached", "--binary"]);

        let error = preview_discard_file(repo.path(), "new.txt", Some("old.txt"), staged)
            .expect_err("stale rename metadata must fail closed");

        assert!(
            error.contains("changed") || error.contains("no longer available"),
            "unexpected error: {error}"
        );
        assert_eq!(
            std::fs::read(repo.0.join("old.txt")).unwrap(),
            b"precious old edit\n"
        );
        assert_eq!(
            std::fs::read(repo.0.join("new.txt")).unwrap(),
            b"precious new edit\n"
        );
        let after_status = repo.git(&["status", "--porcelain=v1", "-z"]);
        let after_index = repo.git(&["diff", "--cached", "--binary"]);
        assert_eq!(
            after_status.stdout, before_status.stdout,
            "worktree status must stay unchanged"
        );
        assert_eq!(
            after_index.stdout, before_index.stdout,
            "the index must stay unchanged"
        );
    }
}

#[test]
fn discard_removes_a_staged_new_file_with_staged_true_on_a_born_repo() {
    // GL-115 Bug 2 regression: the new `git rm -f` path must behave like the
    // old restore-then-clean flow for the staged=true case on a repo that does
    // have history — clearing the staged-new file from index and worktree.
    let repo = TempRepo::new("discard-staged-true-born");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&[
        "commit",
        "-q",
        "--no-gpg-sign",
        "--allow-empty",
        "-m",
        "root",
    ]);

    std::fs::write(repo.0.join("staged_new.txt"), "new\n").unwrap();
    repo.git_ok(&["add", "staged_new.txt"]);

    discard_current(&repo, "staged_new.txt", None, true).expect("discard staged=true new file");
    assert!(
        index_entries(&repo).is_empty(),
        "staged-new file leaves the index"
    );
    assert!(
        !repo.0.join("staged_new.txt").exists(),
        "staged-new file leaves the worktree"
    );
}

#[test]
fn discard_staged_file_works_on_an_unborn_repo() {
    // GL-115 Bug 1 interplay: discard(staged=true) used to open with
    // `restore --staged`, which dies on an unborn HEAD. The `git rm -f` path
    // needs no HEAD at all.
    let repo = TempRepo::new("unborn-discard");
    repo.git_ok(&["init", "-q"]);
    std::fs::write(repo.0.join("new.txt"), "new\n").unwrap();
    stage_files(repo.path(), &["new.txt".into()]).expect("stage on unborn HEAD");

    discard_current(&repo, "new.txt", None, true).expect("discard staged file on unborn HEAD");
    assert!(index_entries(&repo).is_empty(), "file leaves the index");
    assert!(!repo.0.join("new.txt").exists(), "file leaves the worktree");
}

#[test]
fn discard_staged_file_fails_closed_when_head_tree_cannot_be_read() {
    let repo = repo_with_file("discard-missing-head-tree", "root.txt", b"root\n");
    std::fs::create_dir(repo.0.join("nested")).unwrap();
    std::fs::write(repo.0.join("nested/tracked.txt"), b"committed\n").unwrap();
    repo.git_ok(&["add", "nested/tracked.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "add nested file"]);
    std::fs::write(repo.0.join("nested/tracked.txt"), b"staged edit\n").unwrap();
    repo.git_ok(&["add", "nested/tracked.txt"]);

    let subtree = rev_parse(&repo, "HEAD:nested");
    let object_path = repo
        .0
        .join(".git/objects")
        .join(&subtree[..2])
        .join(&subtree[2..]);
    std::fs::remove_file(&object_path).expect("fixture subtree object should be loose");

    let error = preview_discard_file(repo.path(), "nested/tracked.txt", None, true)
        .expect_err("an unreadable HEAD tree must never be treated as a staged-new file");
    assert!(
        error.contains("Could not inspect") || error.contains("unable to read tree"),
        "unexpected error: {error}"
    );
    assert_eq!(
        std::fs::read(repo.0.join("nested/tracked.txt")).unwrap(),
        b"staged edit\n"
    );
    assert_eq!(index_entries(&repo), ["nested/tracked.txt", "root.txt"]);
}

#[test]
fn discard_unstaged_side_of_staged_new_preserves_the_staged_blob() {
    let repo = repo_with_file("discard-staged-new-edited", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("new.txt"), b"staged version\n").unwrap();
    repo.git_ok(&["add", "new.txt"]);
    std::fs::write(repo.0.join("new.txt"), b"working edit!!\n").unwrap();

    discard_current(&repo, "new.txt", None, false)
        .expect("discard only the unstaged side of a staged-new file");

    assert_eq!(
        std::fs::read(repo.0.join("new.txt")).unwrap(),
        b"staged version\n"
    );
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["show", ":new.txt"]).stdout),
        "staged version\n"
    );
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["status", "--porcelain=v1"]).stdout),
        "A  new.txt\n"
    );
}

#[test]
fn discard_intent_to_add_rejects_a_real_stage_transition_and_removes_a_live_ita() {
    let repo = repo_with_file("discard-intent-to-add", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("intent.txt"), b"draft\n").unwrap();
    repo.git_ok(&["add", "-N", "intent.txt"]);
    let preview = preview_discard_file(repo.path(), "intent.txt", None, false).expect("preview");

    repo.git_ok(&["add", "intent.txt"]);
    let error = discard_file(
        repo.path(),
        "intent.txt",
        None,
        false,
        &preview.expected_state,
    )
    .expect_err("turning intent-to-add into staged content must fail closed");
    assert!(
        error.contains("no longer available") || error.contains("changed"),
        "unexpected error: {error}"
    );
    assert!(repo.0.join("intent.txt").exists());
    assert!(index_entries(&repo).contains(&"intent.txt".to_string()));

    repo.git_ok(&["reset", "-q", "HEAD", "--", "intent.txt"]);
    repo.git_ok(&["add", "-N", "intent.txt"]);
    discard_current(&repo, "intent.txt", None, false)
        .expect("git rm -f removes an intent-to-add entry and worktree copy");
    assert!(!repo.0.join("intent.txt").exists());
    assert!(!index_entries(&repo).contains(&"intent.txt".to_string()));
}

#[test]
fn discard_rename_refuses_content_changed_after_preview() {
    for staged in [false, true] {
        let repo = repo_with_file(
            if staged {
                "discard-staged-rename-content-race"
            } else {
                "discard-unstaged-rename-content-race"
            },
            "old.txt",
            b"base\n",
        );
        if staged {
            repo.git_ok(&["mv", "old.txt", "new.txt"]);
        } else {
            std::fs::rename(repo.0.join("old.txt"), repo.0.join("new.txt")).unwrap();
        }
        let preview = preview_discard_file(repo.path(), "new.txt", Some("old.txt"), staged)
            .expect("preview rename");
        let before_index = repo.git(&["diff", "--cached", "--binary"]).stdout;

        std::fs::write(repo.0.join("new.txt"), b"late\n").unwrap();
        let error = discard_file(
            repo.path(),
            "new.txt",
            Some("old.txt"),
            staged,
            &preview.expected_state,
        )
        .expect_err("rename content changed after preview");

        assert!(error.contains("changed"), "unexpected error: {error}");
        assert!(!repo.0.join("old.txt").exists());
        assert_eq!(std::fs::read(repo.0.join("new.txt")).unwrap(), b"late\n");
        assert_eq!(
            repo.git(&["diff", "--cached", "--binary"]).stdout,
            before_index
        );
    }
}
