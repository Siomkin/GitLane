//! Squash against pre-commit and post-commit hooks that stage or rewrite work
//! underneath it.

use super::super::support::*;

#[cfg(unix)]
#[test]
fn squash_keeps_pre_staged_work_when_a_pre_commit_hook_stages() {
    // GL-307: `git commit` runs hooks, and a lint-staged-style pre-commit hook
    // stages into the same index. That staging belongs to the commit we just
    // made, so it must not read as a concurrent writer and skip the restore.
    use std::os::unix::fs::PermissionsExt;

    let (repo, base, tip) = tip_range_for_squash("squash-pre-commit-hook");
    let hook = repo.0.join(".git/hooks/pre-commit");
    std::fs::write(
        &hook,
        "#!/bin/sh\necho hooked > hooked.txt\ngit add hooked.txt\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

    std::fs::write(repo.0.join("wip.txt"), "staged\n").unwrap();
    repo.git_ok(&["add", "wip.txt"]);

    squash_commits(
        repo.path(),
        Some("main"),
        &tip,
        &base,
        "replacement",
        "",
        None,
        None,
        None,
        false,
    )
    .expect("a pre-commit hook that stages must not fail the squash");

    assert!(
        repo.git(&["cat-file", "-e", "HEAD:hooked.txt"])
            .status
            .success(),
        "the hook's staging belongs in the squash commit"
    );
    let cached_out = repo.git(&["diff", "--cached", "--name-only"]);
    let cached = String::from_utf8_lossy(&cached_out.stdout);
    assert!(
        cached.lines().any(|line| line == "wip.txt"),
        "pre-staged work must survive a hook-staging commit; cached=\n{cached}"
    );
    assert!(
        !repo
            .git(&["cat-file", "-e", "HEAD:wip.txt"])
            .status
            .success(),
        "pre-staged path must still stay out of the squash commit"
    );
    // The restored snapshot predates the hook, so without reconciliation the
    // index would read as deleting the very file the hook just committed.
    assert!(
        !cached.lines().any(|line| line == "hooked.txt"),
        "the hook's own path must not be left staged as a deletion; cached=\n{cached}"
    );
}

#[cfg(unix)]
#[test]
fn squash_refuses_to_restore_when_a_post_commit_hook_stages() {
    // A *post*-commit hook stages after the commit exists, so its writes are
    // indistinguishable from a concurrent `git add`. Compare-and-restore takes
    // the safe branch — refuse rather than clobber — and says so. Pinning the
    // policy here so a future change to it is deliberate, not accidental.
    use std::os::unix::fs::PermissionsExt;

    let (repo, base, tip) = tip_range_for_squash("squash-post-commit-hook");
    let hook = repo.0.join(".git/hooks/post-commit");
    std::fs::write(&hook, "#!/bin/sh\necho post > post.txt\ngit add post.txt\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

    std::fs::write(repo.0.join("wip.txt"), "keep-me\n").unwrap();
    repo.git_ok(&["add", "wip.txt"]);

    let error = squash_commits(
        repo.path(),
        Some("main"),
        &tip,
        &base,
        "replacement",
        "",
        None,
        None,
        None,
        false,
    )
    .expect_err("a post-commit hook mutating the index must refuse the restore");

    assert!(
        error.contains("index changed during squash"),
        "unexpected refusal message: {error}"
    );
    // The squash itself is kept — a landed commit is never undone — and the
    // caller's file is still on disk, just no longer staged.
    assert_ne!(
        rev_parse(&repo, "HEAD"),
        tip,
        "the squash commit must remain"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("wip.txt")).unwrap(),
        "keep-me\n",
        "refusing the restore must not touch the worktree"
    );
}

#[cfg(unix)]
#[test]
fn squash_reconciles_a_pre_commit_hook_rename_at_both_endpoints() {
    // `diff-tree --name-only` must list both sides of a rename; if it collapsed
    // to the post-image, the pre-rename path would be left staged for
    // resurrection against the new HEAD.
    use std::os::unix::fs::PermissionsExt;

    let (repo, base, _tip) = tip_range_for_squash("squash-hook-rename");
    std::fs::write(repo.0.join("before.txt"), "aaaa\nbbbb\ncccc\ndddd\n").unwrap();
    repo.git_ok(&["add", "before.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "add before"]);
    let tip = rev_parse(&repo, "HEAD");

    let hook = repo.0.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\ngit mv before.txt after.txt\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    // Rename detection on, to prove the plumbing call ignores it.
    repo.git_ok(&["config", "diff.renames", "true"]);

    std::fs::write(repo.0.join("wip.txt"), "staged\n").unwrap();
    repo.git_ok(&["add", "wip.txt"]);

    squash_commits(
        repo.path(),
        Some("main"),
        &tip,
        &base,
        "replacement",
        "",
        None,
        None,
        None,
        false,
    )
    .expect("squash with a renaming pre-commit hook");

    let cached_out = repo.git(&["diff", "--cached", "--name-only"]);
    let cached = String::from_utf8_lossy(&cached_out.stdout);
    assert!(
        !cached.lines().any(|line| line == "before.txt"),
        "the pre-rename path must not be left staged for resurrection; cached=\n{cached}"
    );
    assert!(
        !cached.lines().any(|line| line == "after.txt"),
        "the renamed path must match the landed commit; cached=\n{cached}"
    );
    assert!(
        cached.lines().any(|line| line == "wip.txt"),
        "pre-staged work must still survive; cached=\n{cached}"
    );
}

#[cfg(unix)]
#[test]
fn squash_prefers_pre_staged_content_over_a_pre_commit_hook_rewrite() {
    // Hook reconciliation must not overwrite the caller's own staging: when both
    // touch a path, the pre-staged version is the one worth keeping.
    use std::os::unix::fs::PermissionsExt;

    let (repo, base, _tip) = tip_range_for_squash("squash-hook-vs-pre-staged");
    std::fs::write(repo.0.join("shared.txt"), "committed\n").unwrap();
    repo.git_ok(&["add", "shared.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "add shared"]);
    let tip = rev_parse(&repo, "HEAD");

    let hook = repo.0.join(".git/hooks/pre-commit");
    std::fs::write(
        &hook,
        "#!/bin/sh\necho hook-rewrote > shared.txt\ngit add shared.txt\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

    std::fs::write(repo.0.join("shared.txt"), "mine-staged\n").unwrap();
    repo.git_ok(&["add", "shared.txt"]);

    squash_commits(
        repo.path(),
        Some("main"),
        &tip,
        &base,
        "replacement",
        "",
        None,
        None,
        None,
        false,
    )
    .expect("squash with a hook rewriting a pre-staged path");

    let staged_blob = repo.git(&["show", ":shared.txt"]);
    assert_eq!(
        String::from_utf8_lossy(&staged_blob.stdout),
        "mine-staged\n",
        "the caller's staged content must outrank the hook's rewrite"
    );
}
