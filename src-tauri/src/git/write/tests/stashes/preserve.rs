//! What a stash must put back that git does not: empty untracked
//! directories, their modes, and the nested repositories it must not walk
//! into.

use super::super::support::*;

#[test]
#[cfg(unix)]
fn stash_finishes_the_restore_git_abandons_on_an_unremovable_directory() {
    // `git stash push --include-untracked` stores the entry, then clears the
    // working tree with a blanket `git clean -fd` *before* `reset --hard`. A
    // directory it cannot remove aborts the push between those two steps, so
    // git exits non-zero having saved everything and restored nothing. GitLane
    // used to surface that raw warning as a plain failure while the stash sat
    // in the list and the tracked edits stayed on disk.
    let repo = stash_seed_repo("stash-unremovable-dir");

    std::fs::write(repo.0.join("f.txt"), b"edited\n").unwrap();
    std::fs::create_dir_all(repo.0.join("trunk/web")).unwrap();
    std::fs::write(repo.0.join("trunk/web/u.txt"), b"untracked\n").unwrap();
    // Read-only parent: git can delete `trunk/web/u.txt` but not `trunk/web`.
    let _mode = RestoredMode::clamp(repo.0.join("trunk"), 0o555);

    let message = stash(repo.path()).expect("an interrupted cleanup still stashes");

    assert!(
        message.contains("Permission denied"),
        "the outcome must name what Git could not remove: {message}"
    );
    let status = repo.git(&["status", "--porcelain"]);
    assert!(
        String::from_utf8_lossy(&status.stdout).trim().is_empty(),
        "the working tree must end up cleared, not split: {}",
        String::from_utf8_lossy(&status.stdout)
    );
    assert!(
        repo.0.join("trunk/web").is_dir(),
        "the directory Git could not remove stays on disk"
    );

    // Everything the push captured must still round-trip out of the entry.
    let oid = stash_list(repo.path()).expect("list")[0].oid.clone();
    stash_apply(repo.path(), &oid).expect("restore the stashed changes");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("f.txt")).unwrap(),
        "edited\n"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("trunk/web/u.txt")).unwrap(),
        "untracked\n"
    );
}

#[test]
fn stash_preserves_empty_untracked_directories() {
    // `git stash push -u` clears captured untracked files with a blanket
    // `git clean -fd`, and `-d` takes empty directories with it. They never
    // appear in `git status` and a stash commit records only blobs, so the
    // deletion is silent and unrecoverable — GL-218's collateral deletion,
    // still live for stash. Every directory here is one git 2.55 was observed
    // to remove.
    let repo = stash_seed_repo("stash-empty-dirs");
    repo.git_ok(&["config", "core.excludesFile", "/dev/null"]);
    std::fs::write(repo.0.join(".gitignore"), b"ignored-dir/\n*.log\n").unwrap();
    repo.git_ok(&["add", ".gitignore"]);
    repo.git_ok(&["commit", "-qm", "ignores"]);

    std::fs::create_dir_all(repo.0.join("plain-empty")).unwrap();
    std::fs::create_dir_all(repo.0.join("nested-empty/a/b")).unwrap();
    // A file-free subtree beside an untracked file: applying the stash puts
    // `mixed/m.txt` back and so recreates `mixed/`, but never `mixed/deep`.
    std::fs::create_dir_all(repo.0.join("mixed/deep")).unwrap();
    std::fs::write(repo.0.join("mixed/m.txt"), b"untracked\n").unwrap();
    // Untouched by `clean` without `-x`; must survive without being clobbered.
    std::fs::create_dir_all(repo.0.join("ignored-dir")).unwrap();
    std::fs::create_dir_all(repo.0.join("only-ignored")).unwrap();
    std::fs::write(repo.0.join("only-ignored/x.log"), b"ignored\n").unwrap();
    std::fs::write(repo.0.join("f.txt"), b"edited\n").unwrap();

    let message = stash(repo.path()).expect("stash the edit");

    assert_eq!(
        message, "Stashed your changes.",
        "preserving directories is not something to report: {message}"
    );
    for kept in [
        "plain-empty",
        "nested-empty",
        "nested-empty/a",
        "nested-empty/a/b",
        "mixed/deep",
        "ignored-dir",
        "only-ignored",
    ] {
        assert!(
            repo.0.join(kept).is_dir(),
            "{kept} must survive the stash — no stash can restore an empty directory"
        );
    }
    assert_eq!(
        std::fs::read_to_string(repo.0.join("only-ignored/x.log")).unwrap(),
        "ignored\n",
        "an ignored file must not be disturbed"
    );
    // The stash itself is unaffected: untracked files still go in and come back.
    let status = repo.git(&["status", "--porcelain"]);
    assert!(
        String::from_utf8_lossy(&status.stdout).trim().is_empty(),
        "the working tree is still cleared: {}",
        String::from_utf8_lossy(&status.stdout)
    );
    let oid = stash_list(repo.path()).expect("list")[0].oid.clone();
    stash_apply(repo.path(), &oid).expect("restore the stash");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("mixed/m.txt")).unwrap(),
        "untracked\n"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("f.txt")).unwrap(),
        "edited\n"
    );
}

#[test]
fn stash_still_handles_a_staged_deletion_alongside_an_empty_directory() {
    // This is why preservation restores rather than prevents. Scoping git's
    // cleanup by driving the push with an explicit pathspec would also spare
    // empty directories, but git's pathspec mode runs a bare `git add --
    // <paths>` that dies with "pathspec did not match any files" on a staged
    // deletion — the path is in neither the index nor the worktree — after the
    // entry is already stored. Both must work at once.
    let repo = stash_seed_repo("stash-staged-deletion");
    std::fs::write(repo.0.join("doomed.txt"), b"doomed\n").unwrap();
    repo.git_ok(&["add", "doomed.txt"]);
    repo.git_ok(&["commit", "-qm", "add doomed"]);
    repo.git_ok(&["rm", "-q", "doomed.txt"]);
    std::fs::create_dir_all(repo.0.join("empty")).unwrap();
    std::fs::write(repo.0.join("f.txt"), b"edited\n").unwrap();

    stash(repo.path()).expect("a staged deletion stashes alongside an empty dir");

    let status = repo.git(&["status", "--porcelain"]);
    assert!(
        String::from_utf8_lossy(&status.stdout).trim().is_empty(),
        "the staged deletion must be stashed, not left behind: {}",
        String::from_utf8_lossy(&status.stdout)
    );
    assert!(repo.0.join("doomed.txt").is_file(), "the file is restored");
    assert!(
        repo.0.join("empty").is_dir(),
        "the empty directory survives"
    );

    let oid = stash_list(repo.path()).expect("list")[0].oid.clone();
    stash_apply(repo.path(), &oid).expect("restore the stash");
    assert!(
        !repo.0.join("doomed.txt").exists(),
        "applying the stash reinstates the deletion"
    );
}

#[test]
fn stash_does_not_walk_into_a_nested_repository() {
    // Git's cleanup skips a nested repository ("Ignoring path foo/"), so it is
    // neither at risk nor ours to walk — and an empty directory inside one
    // belongs to that repository, not this worktree.
    let repo = stash_seed_repo("stash-empty-dirs-nested");
    let nested = repo.0.join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    let init = Command::new("git")
        .args(["init", "-q", nested.to_str().unwrap()])
        .output()
        .expect("git init launches");
    assert!(init.status.success(), "nested git init failed");
    std::fs::create_dir_all(nested.join("its-own-empty")).unwrap();
    std::fs::write(repo.0.join("f.txt"), b"edited\n").unwrap();

    stash(repo.path()).expect("stash the edit");

    assert!(nested.join(".git").exists(), "the nested repo survives");
    assert!(
        nested.join("its-own-empty").is_dir(),
        "a directory inside a skipped nested repo is untouched either way"
    );
}

#[test]
#[cfg(unix)]
fn stash_restores_the_mode_of_a_preserved_directory() {
    // Recreating the directory is only half of putting it back; a mode the user
    // set on purpose has to come with it.
    use std::os::unix::fs::PermissionsExt;
    let repo = stash_seed_repo("stash-empty-dir-mode");
    let guarded = repo.0.join("guarded");
    std::fs::create_dir_all(&guarded).unwrap();
    std::fs::set_permissions(&guarded, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(repo.0.join("f.txt"), b"edited\n").unwrap();

    stash(repo.path()).expect("stash the edit");

    let mode = std::fs::metadata(&guarded).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o700, "the directory's mode is restored too");
}
