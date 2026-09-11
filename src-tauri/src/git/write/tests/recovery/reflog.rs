//! Reflog-backed recovery points: what the list exposes, how it is scoped,
//! and the empty cases that must not be errors.

use super::super::support::*;

#[test]
fn reflog_entries_expose_recovery_commits() {
    let repo = TempRepo::new("reflog");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git(&["commit", "-qam", "two"]);
    repo.git(&["reset", "--hard", "HEAD~1"]);

    let entries = reflog_entries(repo.path(), 12).expect("reflog entries");
    assert!(entries.iter().any(|entry| entry.subject.contains("reset")));
    assert!(entries
        .iter()
        .any(|entry| entry.short_selector.contains("HEAD@{")));
}

#[test]
fn reflog_entries_use_reflog_time_not_commit_time() {
    let repo = TempRepo::new("reflog-time");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"old\n").unwrap();
    repo.git(&["add", "f.txt"]);
    let old_timestamp = 946_684_800_i64;
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo.0)
        .args(["commit", "-qm", "old"])
        .env("GIT_AUTHOR_DATE", format!("@{old_timestamp} +0000"))
        .env("GIT_COMMITTER_DATE", format!("@{old_timestamp} +0000"))
        .output()
        .expect("git launches in tests");
    assert!(
        out.status.success(),
        "old commit failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    std::fs::write(repo.0.join("f.txt"), b"new\n").unwrap();
    repo.git(&["commit", "-qam", "new"]);
    repo.git(&["reset", "--hard", "HEAD~1"]);

    let entries = reflog_entries(repo.path(), 12).expect("reflog entries");
    let reset = entries
        .iter()
        .find(|entry| entry.subject.contains("reset"))
        .expect("reset reflog entry");
    assert!(
        reset.timestamp > old_timestamp,
        "reset timestamp should be the reflog event time, not old commit time: {:?}",
        reset
    );
}

#[test]
fn reflog_entries_scope_excludes_remote_and_stash() {
    let repo = TempRepo::new("reflog-scope");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "base"]);
    // A remote-tracking ref update and a stash both create reflog entries that
    // `git log -g --all` would surface but the recovery list must not.
    repo.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
    std::fs::write(repo.0.join("f.txt"), b"dirty\n").unwrap();
    repo.git(&["stash", "-q"]);

    let entries = reflog_entries(repo.path(), 50).expect("reflog entries");
    assert!(!entries.is_empty(), "HEAD/branch entries should remain");
    assert!(
        entries
            .iter()
            .all(|e| !e.selector.contains("remotes") && !e.selector.contains("stash")),
        "remote-tracking and stash reflog entries must be excluded: {:?}",
        entries.iter().map(|e| &e.selector).collect::<Vec<_>>()
    );
}

#[test]
fn reflog_entries_on_unborn_repo_is_empty_not_error() {
    // With neither HEAD nor any branch ref, there are no recovery points.
    let repo = TempRepo::new("reflog-empty");
    repo.git(&["init", "-q", "-b", "main"]);
    let entries = reflog_entries(repo.path(), 12).expect("reflog entries on empty repo");
    assert!(entries.is_empty());
}

#[test]
fn reflog_entries_keep_branch_recovery_points_on_an_unborn_orphan_head() {
    let repo = repo_with_file("reflog-orphan", "f.txt", b"base\n");
    repo.git_ok(&["checkout", "--orphan", "empty"]);
    repo.git_ok(&["rm", "-q", "-rf", "."]);

    assert!(!repo
        .git(&["rev-parse", "--verify", "HEAD"])
        .status
        .success());
    let entries = reflog_entries(repo.path(), 12).expect("branch reflog entries");
    assert!(
        entries
            .iter()
            .any(|entry| entry.selector.contains("main@{")),
        "main's recovery reflog must remain visible: {entries:?}"
    );
}

#[test]
fn reflog_entries_with_no_reflog_is_empty_not_error() {
    // A committed repo whose reflog was pruned/disabled: HEAD resolves, but
    // `git log -g HEAD --branches` exits 0 with no output (it does NOT error),
    // so the read yields an empty list rather than surfacing a git failure.
    let repo = TempRepo::new("reflog-pruned");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "base"]);
    std::fs::remove_dir_all(repo.0.join(".git/logs")).unwrap();

    let entries = reflog_entries(repo.path(), 12).expect("reflog entries with no reflog");
    assert!(entries.is_empty());
}

/// Set up offline SSH commit signing in `repo` and turn on the config that
/// makes every `git log` verify signatures and print the verdict to stdout.
fn sign_with_ssh_and_show_signatures(repo: &TempRepo) {
    let key = repo.0.join("signing-key");
    let out = std::process::Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-C", "gitlane-test", "-f"])
        .arg(&key)
        .output()
        .expect("ssh-keygen launches");
    assert!(out.status.success(), "ssh-keygen failed");
    let public = std::fs::read_to_string(key.with_extension("pub")).unwrap();
    let allowed = repo.0.join("allowed-signers");
    std::fs::write(&allowed, format!("gitlane@example.test {public}")).unwrap();

    repo.git_ok(&["config", "gpg.format", "ssh"]);
    repo.git_ok(&["config", "user.signingkey", key.to_str().unwrap()]);
    repo.git_ok(&[
        "config",
        "gpg.ssh.allowedSignersFile",
        allowed.to_str().unwrap(),
    ]);
    repo.git_ok(&["config", "commit.gpgsign", "true"]);
    repo.git_ok(&["config", "log.showSignature", "true"]);
}

/// `log.showSignature=true` makes every `git log` print its verification
/// verdict — on stdout, ahead of the record the format asked for. The reflog
/// read parses one record per line, so those lines become entries with the
/// whole line as an oid and a zero timestamp.
#[test]
fn reflog_entries_ignore_signature_output_from_log_show_signature() {
    let repo = TempRepo::new("reflog-show-signature");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    sign_with_ssh_and_show_signatures(&repo);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["commit", "-qam", "two"]);

    let entries = reflog_entries(repo.path(), 12).expect("reflog entries");

    assert!(!entries.is_empty(), "the two commits must be listed");
    for entry in &entries {
        assert_eq!(entry.oid.len(), 40, "oid field is an oid: {:?}", entry.oid);
        assert!(
            entry.timestamp > 0,
            "every entry carries a reflog time: {entry:?}"
        );
        assert!(
            entry.short_selector.contains("@{"),
            "every entry carries a selector: {entry:?}"
        );
    }
}
