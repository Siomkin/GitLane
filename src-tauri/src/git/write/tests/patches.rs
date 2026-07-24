//! `patches` write-path tests.

use super::support::*;

#[test]
fn create_patch_refuses_merges_and_never_overwrites_an_existing_file() {
    let repo = repo_with_file("create-patch-safe", "base.txt", b"base\n");
    repo.git_ok(&["checkout", "-q", "-b", "side"]);
    std::fs::write(repo.0.join("side.txt"), b"side\n").unwrap();
    repo.git_ok(&["add", "side.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "side"]);
    repo.git_ok(&["checkout", "-q", "main"]);
    repo.git_ok(&[
        "commit",
        "-q",
        "--allow-empty",
        "--no-gpg-sign",
        "-m",
        "main",
    ]);
    repo.git_ok(&[
        "merge",
        "-q",
        "--no-ff",
        "--no-gpg-sign",
        "-m",
        "merge",
        "side",
    ]);
    let merge = rev_parse(&repo, "HEAD");
    assert!(create_patch(repo.path(), &merge).is_err());
    assert!(!repo.0.join("0001-side.patch").exists());

    let side = rev_parse(&repo, "side");
    std::fs::write(repo.0.join("0001-side.patch"), b"keep me\n").unwrap();
    let created = create_patch(repo.path(), &side).expect("create collision-safe patch");
    assert_eq!(created, "0001-side-2.patch");
    assert_eq!(
        std::fs::read(repo.0.join("0001-side.patch")).unwrap(),
        b"keep me\n"
    );
    let patch = std::fs::read(repo.0.join(created)).unwrap();
    assert!(patch.starts_with(b"From "));
}

#[test]
fn create_patch_range_writes_one_mailbox_for_the_range() {
    let repo = repo_with_file("create-patch-range", "base.txt", b"base\n");
    let base = rev_parse(&repo, "HEAD");
    for n in 1..=3 {
        std::fs::write(repo.0.join(format!("f{n}.txt")), format!("v{n}\n")).unwrap();
        repo.git_ok(&["add", "."]);
        repo.git_ok(&[
            "commit",
            "-q",
            "--no-gpg-sign",
            "-m",
            &format!("commit {n}"),
        ]);
    }
    let head = rev_parse(&repo, "HEAD");

    let created = create_patch_range(repo.path(), &base, &head).expect("range patch");
    assert!(created.starts_with("3-commits-"), "got {created}");
    let patch = std::fs::read(repo.0.join(&created)).unwrap();
    // A mailbox with all three commits: three "From <sha>" boundary lines.
    let boundaries = patch.windows(5).filter(|w| w == b"From ").count();
    assert_eq!(boundaries, 3, "expected 3 mailbox boundaries");

    // Collision-safe: a second call for the same range picks a fresh name.
    let again = create_patch_range(repo.path(), &base, &head).expect("second range patch");
    assert_ne!(again, created);
}

#[test]
fn create_patch_range_rejects_a_merge_in_the_range() {
    let repo = repo_with_file("create-patch-range-merge", "base.txt", b"base\n");
    let base = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "-b", "side"]);
    std::fs::write(repo.0.join("side.txt"), b"side\n").unwrap();
    repo.git_ok(&["add", "side.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "side"]);
    repo.git_ok(&["checkout", "-q", "main"]);
    std::fs::write(repo.0.join("main.txt"), b"main\n").unwrap();
    repo.git_ok(&["add", "main.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "main"]);
    repo.git_ok(&[
        "merge",
        "-q",
        "--no-ff",
        "--no-gpg-sign",
        "-m",
        "merge",
        "side",
    ]);
    let head = rev_parse(&repo, "HEAD");

    assert!(create_patch_range(repo.path(), &base, &head).is_err());
}

#[test]
fn create_working_tree_patch_writes_tracked_and_untracked_deltas() {
    let repo = repo_with_file("wip-patch", "tracked.txt", b"base\n");
    std::fs::write(repo.0.join("tracked.txt"), b"edited\n").unwrap();
    std::fs::write(repo.0.join("new.txt"), b"brand new\n").unwrap();

    let tracked = create_working_tree_patch(repo.path(), "tracked.txt").expect("tracked patch");
    assert!(tracked.starts_with("wip-tracked"), "got {tracked}");
    let tracked_body = std::fs::read_to_string(repo.0.join(&tracked)).unwrap();
    assert!(tracked_body.contains("-base"));
    assert!(tracked_body.contains("+edited"));

    let untracked = create_working_tree_patch(repo.path(), "new.txt").expect("untracked patch");
    assert!(untracked.starts_with("wip-new"), "got {untracked}");
    let untracked_body = std::fs::read_to_string(repo.0.join(&untracked)).unwrap();
    assert!(untracked_body.contains("+brand new") || untracked_body.contains("brand new"));

    assert!(create_working_tree_patch(repo.path(), "../escape").is_err());
}

#[test]
fn create_working_tree_patch_covers_a_staged_deletion() {
    let repo = repo_with_file("wip-patch-deletion", "gone.txt", b"base\n");
    repo.git_ok(&["rm", "-q", "gone.txt"]);

    let created = create_working_tree_patch(repo.path(), "gone.txt").expect("deletion patch");
    let body = std::fs::read_to_string(repo.0.join(&created)).unwrap();
    assert!(
        body.contains("-base") || body.contains("deleted file"),
        "expected a deletion delta, got:\n{body}"
    );
    assert!(
        !body.contains("+++ /dev/null\n@@") || body.contains("--- a/gone.txt"),
        "must not misclassify the staged deletion as an untracked add"
    );
}

#[test]
fn create_working_tree_patch_keeps_untracked_binary_bytes() {
    let repo = repo_with_file("wip-patch-binary", "seed.txt", b"seed\n");
    // A small payload with a NUL so UTF-8 lossy conversion would alter it if
    // the untracked path still routed through String.
    let bytes = b"BIN\0ARY\xffpayload";
    std::fs::write(repo.0.join("blob.bin"), bytes).unwrap();

    let created = create_working_tree_patch(repo.path(), "blob.bin").expect("binary patch");
    let patch = std::fs::read(repo.0.join(&created)).unwrap();
    assert!(
        !patch.is_empty(),
        "binary untracked files must still produce a patch"
    );
    // `--binary` embeds a literal or binary delta; either way the mailbox must
    // mention the path and not be an empty UTF-8-trimmed husk.
    let text = String::from_utf8_lossy(&patch);
    assert!(
        text.contains("blob.bin"),
        "patch should name the file, got:\n{text}"
    );
}

#[test]
fn create_working_tree_patch_accepts_a_leading_dash_filename() {
    let repo = repo_with_file("wip-dash-name", "seed.txt", b"seed\n");
    std::fs::write(repo.0.join("-notes.txt"), b"dashy\n").unwrap();

    let created = create_working_tree_patch(repo.path(), "-notes.txt").expect("dash patch");
    let body = std::fs::read_to_string(repo.0.join(&created)).unwrap();
    assert!(
        body.contains("dashy") || body.contains("-notes.txt"),
        "got:\n{body}"
    );
}

#[test]
fn create_working_tree_patch_on_unborn_head_includes_unstaged_edits() {
    let repo = TempRepo::new("wip-unborn-both");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("a.txt"), b"staged\n").unwrap();
    repo.git_ok(&["add", "a.txt"]);
    std::fs::write(repo.0.join("a.txt"), b"staged then worktree\n").unwrap();

    let created = create_working_tree_patch(repo.path(), "a.txt").expect("unborn patch");
    let body = std::fs::read_to_string(repo.0.join(&created)).unwrap();
    assert!(
        body.contains("worktree") || body.contains("staged then worktree"),
        "unstaged edits must appear in the unborn-HEAD patch, got:\n{body}"
    );
    // Must be a single applyable mailbox (not concatenated cached+unstaged).
    let apply_repo = TempRepo::new("wip-unborn-apply");
    apply_repo.git_ok(&["init", "-q", "-b", "main"]);
    apply_repo.git_ok(&["config", "user.name", "GitLane Test"]);
    apply_repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    apply_repo.git_ok(&["config", "commit.gpgsign", "false"]);
    apply_repo
        .git_ok(&["apply", repo.0.join(&created).to_str().unwrap()]);
    assert_eq!(
        std::fs::read_to_string(apply_repo.0.join("a.txt")).unwrap(),
        "staged then worktree\n"
    );
}

#[cfg(unix)]
#[test]
fn create_working_tree_patch_refuses_symlink_ancestor_escape() {
    let repo = repo_with_file("wip-symlink-escape", "seed.txt", b"seed\n");
    let outside = std::env::temp_dir().join(format!(
        "gitlane-wip-outside-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), b"secret\n").unwrap();
    std::os::unix::fs::symlink(&outside, repo.0.join("escape")).unwrap();

    let err = create_working_tree_patch(repo.path(), "escape/secret.txt")
        .expect_err("symlink ancestor must refuse");
    assert!(
        err.contains("escape")
            || err.contains("Couldn't patch")
            || err.contains("symlink")
            || err.contains("Refusing"),
        "expected a path-safety error, got: {err}"
    );
    let _ = std::fs::remove_dir_all(&outside);
}
