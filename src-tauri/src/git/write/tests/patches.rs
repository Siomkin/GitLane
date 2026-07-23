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
