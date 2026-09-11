//! The commit message and author GitLane composes must be what git records,
//! whatever the user's config and environment say.

use super::super::support::*;

/// `commit.cleanup=strip` drops every line that starts with the comment
/// character. GitLane composes the message itself, so there are no comments to
/// strip — only the user's own text to lose.
#[test]
fn commit_keeps_a_summary_that_starts_with_the_comment_character() {
    let repo = TempRepo::new("commit-cleanup-strip");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.cleanup", "strip"]);
    repo.git_ok(&["symbolic-ref", "HEAD", "refs/heads/main"]);
    std::fs::write(repo.0.join("file.txt"), "one\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);

    commit_expected(
        repo.path(),
        &CommitRequest {
            expected_branch: Some("main".to_string()),
            description: "Body explaining the fix".to_string(),
            ..CommitRequest::test("#77 Fix the crash")
        },
    )
    .expect("commit succeeds");

    let subject = repo.git(&["log", "-1", "--format=%s"]);
    assert_eq!(
        String::from_utf8_lossy(&subject.stdout).trim(),
        "#77 Fix the crash"
    );
    let body = repo.git(&["log", "-1", "--format=%b"]);
    assert!(String::from_utf8_lossy(&body.stdout).contains("Body explaining the fix"));
}

/// A description line beginning with the comment character survives too.
#[test]
fn commit_keeps_a_description_line_that_starts_with_the_comment_character() {
    let repo = TempRepo::new("commit-cleanup-body");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.cleanup", "strip"]);
    repo.git_ok(&["symbolic-ref", "HEAD", "refs/heads/main"]);
    std::fs::write(repo.0.join("file.txt"), "one\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);

    commit_expected(
        repo.path(),
        &CommitRequest {
            expected_branch: Some("main".to_string()),
            description: "#hash-leading note\nreal body".to_string(),
            ..CommitRequest::test("Plain subject")
        },
    )
    .expect("commit succeeds");

    let message = repo.git(&["log", "-1", "--format=%B"]);
    assert!(
        String::from_utf8_lossy(&message.stdout).contains("#hash-leading note"),
        "the description line the user typed must survive"
    );
}

/// `git symbolic-ref --short` shortens *ambiguity-aware*: with a tag named
/// like the checked-out branch it prints `heads/<name>` rather than the bare
/// name. The summary the UI compares against comes from libgit2, which strips
/// the prefix literally, so every operation guarded by the current branch
/// refused until the tag was renamed.
#[test]
fn head_guarded_writes_work_when_a_tag_shares_the_branch_name() {
    let repo = TempRepo::new("head-tag-shadow");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    repo.git_ok(&["symbolic-ref", "HEAD", "refs/heads/latest"]);
    std::fs::write(repo.0.join("file.txt"), "one\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    // A tag by the same name as the checked-out branch.
    repo.git_ok(&["tag", "latest"]);
    let head = rev_parse(&repo, "HEAD");

    std::fs::write(repo.0.join("file.txt"), "two\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);

    commit_expected(
        repo.path(),
        &CommitRequest {
            expected_branch: Some("latest".to_string()),
            expected_oid: Some(head),
            ..CommitRequest::test("second commit")
        },
    )
    .expect("commit while a tag shadows the branch name");

    let subject = repo.git(&["log", "-1", "--format=%s"]);
    assert_eq!(
        String::from_utf8_lossy(&subject.stdout).trim(),
        "second commit"
    );
}

/// The same guard must still report "no branch" on a detached HEAD.
#[test]
fn head_guard_reports_no_branch_when_head_is_detached() {
    let repo = TempRepo::new("head-detached");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("file.txt"), "one\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    let head = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-q", "--detach", &head]);

    std::fs::write(repo.0.join("file.txt"), "two\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);

    let err = commit_expected(
        repo.path(),
        &CommitRequest {
            expected_branch: Some("main".to_string()),
            expected_oid: Some(head),
            ..CommitRequest::test("should refuse")
        },
    )
    .unwrap_err();
    assert!(err.contains("detached HEAD"), "got {err}");
}
