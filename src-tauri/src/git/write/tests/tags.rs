//! `tags` write-path tests.

use super::support::*;

#[test]
fn create_tag_stays_lightweight_under_tag_gpgsign() {
    let repo = TempRepo::new("lightweight-tag-gpgsign");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    // The regression: tag.gpgsign=true upgrades a plain `git tag` to a *signed*
    // tag, which needs a message — git then launches an editor this GUI
    // subprocess can't provide and the command fails. `--no-sign` must keep the
    // "Tag here…" path genuinely lightweight.
    repo.git_ok(&["config", "tag.gpgsign", "true"]);
    std::fs::write(repo.0.join("a.txt"), "one\n").unwrap();
    repo.git_ok(&["add", "a.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "initial"]);

    create_tag(repo.path(), "v0.0.1", None).expect("lightweight tag under tag.gpgsign=true");

    // A lightweight tag points straight at the commit; a signed/annotated one
    // would resolve to a tag object.
    let out = repo.git(&["cat-file", "-t", "refs/tags/v0.0.1"]);
    assert!(out.status.success(), "tag ref should exist");
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "commit",
        "tag must stay lightweight (no tag object)"
    );
}

#[test]
fn delete_remote_tag_removes_only_the_tag_on_the_remote() {
    let repo = TempRepo::new("delete-remote-tag");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "one\n").unwrap();
    repo.git_ok(&["add", "a.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "initial"]);
    repo.git_ok(&["tag", "--no-sign", "v1"]);
    // A branch sharing the tag's short name — the fully-qualified `refs/tags/`
    // delete refspec must never touch it.
    repo.git_ok(&["branch", "v1"]);
    let expected = rev_parse(&repo, "refs/tags/v1");

    let remote = TempRepo::new("delete-remote-tag-origin");
    remote.git_ok(&["init", "-q", "--bare"]);
    repo.git_ok(&["remote", "add", "origin", remote.path()]);
    repo.git_ok(&["push", "-q", "origin", "refs/tags/v1", "refs/heads/v1"]);

    delete_remote_tag(
        repo.path(),
        "origin",
        "v1",
        &expected,
        &TransportCredential::None,
    )
    .expect("delete tag on remote");

    let tags = remote.git(&["tag"]);
    assert!(
        !String::from_utf8_lossy(&tags.stdout).contains("v1"),
        "remote tag should be gone"
    );
    let branch = remote.git(&["show-ref", "--verify", "refs/heads/v1"]);
    assert!(
        branch.status.success(),
        "same-named remote branch must survive the tag delete"
    );
    let local = repo.git(&["show-ref", "--verify", "refs/tags/v1"]);
    assert!(
        local.status.success(),
        "local tag ref is not touched by the remote delete"
    );
}

#[test]
fn delete_tag_refuses_to_remove_a_tag_moved_after_confirmation() {
    let repo = repo_with_file("delete-local-tag-lease", "a.txt", b"one\n");
    repo.git_ok(&["tag", "--no-sign", "v1"]);
    let expected = rev_parse(&repo, "refs/tags/v1");

    std::fs::write(repo.0.join("a.txt"), b"two\n").unwrap();
    repo.git_ok(&["add", "a.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "second"]);
    repo.git_ok(&["tag", "--no-sign", "-f", "v1"]);
    let moved = rev_parse(&repo, "refs/tags/v1");
    assert_ne!(expected, moved);

    let error = delete_tag(repo.path(), "v1", &expected)
        .expect_err("stale confirmation must not delete the moved tag");
    assert!(
        error.contains("cannot lock ref") || error.contains("is at"),
        "unexpected update-ref diagnostic: {error}"
    );
    assert_eq!(rev_parse(&repo, "refs/tags/v1"), moved);

    delete_tag(repo.path(), "v1", &moved).expect("current tag target can be deleted");
    assert!(
        !repo
            .git(&["show-ref", "--verify", "refs/tags/v1"])
            .status
            .success(),
        "tag should be absent after an exact-target delete"
    );
}

#[test]
fn delete_remote_tag_refuses_to_remove_a_tag_moved_after_confirmation() {
    let repo = repo_with_file("delete-remote-tag-lease", "a.txt", b"one\n");
    repo.git_ok(&["tag", "--no-sign", "v1"]);
    let expected = rev_parse(&repo, "refs/tags/v1");
    let remote = TempRepo::new("delete-remote-tag-lease-origin");
    remote.git_ok(&["init", "-q", "--bare"]);
    repo.git_ok(&["remote", "add", "origin", remote.path()]);
    repo.git_ok(&["push", "-q", "origin", "refs/tags/v1"]);

    std::fs::write(repo.0.join("a.txt"), b"two\n").unwrap();
    repo.git_ok(&["add", "a.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "second"]);
    repo.git_ok(&["tag", "--no-sign", "-f", "v1"]);
    let moved = rev_parse(&repo, "refs/tags/v1");
    repo.git_ok(&["push", "-q", "--force", "origin", "refs/tags/v1"]);

    delete_remote_tag(
        repo.path(),
        "origin",
        "v1",
        &expected,
        &TransportCredential::None,
    )
    .expect_err("stale confirmation must not delete the moved remote tag");

    assert_eq!(rev_parse(&remote, "refs/tags/v1"), moved);
}

#[test]
fn delete_remote_tag_checks_absence_on_the_push_endpoint() {
    let repo = repo_with_file("delete-remote-tag-pushurl", "a.txt", b"one\n");
    repo.git_ok(&["tag", "--no-sign", "v1"]);
    let expected = rev_parse(&repo, "refs/tags/v1");

    let fetch_remote = TempRepo::new("delete-remote-tag-fetch-url");
    fetch_remote.git_ok(&["init", "-q", "--bare"]);
    let push_remote = TempRepo::new("delete-remote-tag-push-url");
    push_remote.git_ok(&["init", "-q", "--bare"]);
    repo.git_ok(&["remote", "add", "origin", fetch_remote.path()]);
    repo.git_ok(&["remote", "set-url", "--push", "origin", push_remote.path()]);
    repo.git_ok(&["push", "-q", "origin", "refs/tags/v1"]);

    std::fs::write(repo.0.join("a.txt"), b"two\n").unwrap();
    repo.git_ok(&["add", "a.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "second"]);
    repo.git_ok(&["tag", "--no-sign", "-f", "v1"]);
    let moved = rev_parse(&repo, "refs/tags/v1");
    repo.git_ok(&["push", "-q", "--force", "origin", "refs/tags/v1"]);

    delete_remote_tag(
        repo.path(),
        "origin",
        "v1",
        &expected,
        &TransportCredential::None,
    )
    .expect_err("an absent fetch URL must not hide a stale tag on the push URL");

    assert_eq!(rev_parse(&push_remote, "refs/tags/v1"), moved);
}

#[test]
fn delete_remote_tag_tolerates_a_tag_that_was_never_pushed() {
    let repo = TempRepo::new("delete-remote-tag-unpushed");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "one\n").unwrap();
    repo.git_ok(&["add", "a.txt"]);
    repo.git_ok(&["commit", "-q", "--no-gpg-sign", "-m", "initial"]);
    repo.git_ok(&["tag", "--no-sign", "v9"]);
    let expected = rev_parse(&repo, "refs/tags/v9");

    let remote = TempRepo::new("delete-remote-tag-unpushed-origin");
    remote.git_ok(&["init", "-q", "--bare"]);
    repo.git_ok(&["remote", "add", "origin", remote.path()]);

    // "Delete everywhere" on a local-only tag: absence upstream is the desired
    // end state, so this must not fail (the combined delete then proceeds to
    // the local half). How git reports it varies by transport — file remotes
    // exit 0 with a "deleting a non-existent ref" warning, smart-HTTP servers
    // reject with "remote ref does not exist" (mapped to Ok by the tolerance
    // tested below) — so assert the behavior, not the message.
    delete_remote_tag(
        repo.path(),
        "origin",
        "v9",
        &expected,
        &TransportCredential::None,
    )
    .expect("missing remote ref is not a failure");

    let local = repo.git(&["show-ref", "--verify", "refs/tags/v9"]);
    assert!(local.status.success(), "local tag is untouched");
}
