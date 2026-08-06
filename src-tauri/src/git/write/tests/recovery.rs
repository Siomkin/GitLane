//! `recovery` write-path tests.

use super::support::*;

#[test]
fn preview_remove_worktree_lease_ignored_only_drift_does_not_invalidate() {
    let repo = TempRepo::new("wt-lease-drift");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join(".gitignore"), "secret.env\n").unwrap();
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-lease-drift");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);

    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview clean");
    assert!(!preview.requires_force);
    assert_eq!(preview.dirty.ignored, 0);

    std::fs::write(linked.0.join("secret.env"), "TOKEN=1\n").unwrap();
    // Ignored-only drift must not invalidate the lease (disclosure only).
    remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect("ignored-only drift does not invalidate");
}

#[test]
fn preview_remove_worktree_lease_rejects_new_untracked_path() {
    let repo = TempRepo::new("wt-lease-untracked");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-lease-untracked");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview");
    std::fs::write(linked.0.join("new.txt"), "x\n").unwrap();
    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("new untracked path must invalidate");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
    assert!(
        linked.0.exists(),
        "stale lease must not remove the worktree"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}

#[test]
fn preview_remove_worktree_lease_rejects_lock_drift() {
    let repo = TempRepo::new("wt-lease-lock");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-lease-lock");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview unlocked");
    assert!(!preview.locked);
    assert!(!preview.requires_force);

    repo.git_ok(&["worktree", "lock", linked.as_str()]);
    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("locking after preview must invalidate the lease");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
    // Worktree must still exist — execute must not escalate to -f -f off-lease.
    assert!(
        linked.0.exists(),
        "lock drift must refuse, not force-remove"
    );
    repo.git_ok(&["worktree", "remove", "--force", "--force", linked.as_str()]);
}

#[test]
fn preview_remove_worktree_lease_rejects_gitdir_registration_replacement() {
    use std::path::PathBuf;

    let repo = TempRepo::new("wt-lease-gitdir");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-lease-gitdir");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview");

    // Replace the private admin gitdir at the same pathname so the workdir
    // inode is unchanged but registration identity (gitdir inode) flips — the
    // ADR's registration half of the lease must fail closed.
    let gitfile = std::fs::read_to_string(linked.0.join(".git")).unwrap();
    let gitdir = PathBuf::from(
        gitfile
            .trim()
            .strip_prefix("gitdir: ")
            .expect("linked worktree gitfile"),
    );
    let gitdir = if gitdir.is_absolute() {
        gitdir
    } else {
        linked.0.join(gitdir)
    };
    let gitdir = gitdir.canonicalize().unwrap();
    StagedDirReplacement::stage(&gitdir)
        .expect("stage the private gitdir")
        .apply()
        .expect("swap in a gitdir with the same contents and a new inode");

    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("replaced registration must invalidate the lease");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
    assert!(
        linked.0.exists(),
        "stale lease must not remove the worktree"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}

#[test]
fn preview_remove_worktree_lease_survives_same_status_in_place_edit() {
    let (repo, linked, tracked) = repo_with_dirty_linked_worktree("wt-lease-inplace");

    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview dirty");
    assert!(preview.requires_force, "an edited tracked file is dirty");
    assert_eq!(preview.dirty.modified, 1);

    // Same path, same ` M` status code — only the bytes differ.
    std::fs::write(&tracked, "edited again, at greater length\n").unwrap();

    remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect("an in-place edit keeping the same porcelain status must not invalidate");
    assert!(!linked.0.exists(), "the worktree directory should be gone");
}

// The other side of the same line: staging that file changes ` M` to `M `, which
// is a different porcelain record and must expire the confirm even though the
// path set and the dirty *count* are both unchanged.

#[test]
fn preview_remove_worktree_lease_rejects_status_code_change() {
    let (repo, linked, _tracked) = repo_with_dirty_linked_worktree("wt-lease-status");

    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview dirty");
    assert_eq!(preview.dirty.modified, 1);

    git_ok_at(&linked.0, &["add", "a.txt"]);

    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("a status-code change must invalidate the lease");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
    assert!(
        linked.0.exists(),
        "stale lease must not remove the worktree"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}

#[test]
fn preview_remove_worktree_lease_rejects_head_movement() {
    let repo = TempRepo::new("wt-lease-head");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-lease-head");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview");
    assert!(
        preview.head_oid.is_some(),
        "detached worktrees lease a HEAD"
    );

    // Commit inside the worktree: the tree is clean again afterwards, so only
    // the leased HEAD oid catches this.
    std::fs::write(linked.0.join("b.txt"), "b\n").unwrap();
    git_ok_at(&linked.0, &["add", "b.txt"]);
    git_ok_at(
        &linked.0,
        &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "moved"],
    );

    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("HEAD movement must invalidate the lease");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
    assert!(
        linked.0.exists(),
        "stale lease must not remove the worktree"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}

// Story 8: attach↔detach must invalidate even though the path, the contents and
// the commit all stay put — only the branch half of the lease moves.

#[test]
fn preview_remove_worktree_lease_rejects_attach_to_detach() {
    let repo = TempRepo::new("wt-lease-detach");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["branch", "-M", "main"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);
    repo.git_ok(&["branch", "feature"]);

    let linked = LinkedDir::new("wt-lease-detach");
    repo.git_ok(&["worktree", "add", "-q", linked.as_str(), "feature"]);
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview attached");
    assert_eq!(preview.branch.as_deref(), Some("feature"));

    // Same commit, no branch — the HEAD oid alone would not notice.
    git_ok_at(&linked.0, &["checkout", "-q", "--detach"]);

    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("detaching after preview must invalidate the lease");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
    assert!(
        linked.0.exists(),
        "stale lease must not remove the worktree"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}

// Path Reuse / ABA, workdir half (story 6's headline scenario): the directory at
// the leased path is destroyed and rebuilt with identical contents, so only the
// filesystem identity in the fingerprint can tell the replacement apart.

#[test]
fn preview_remove_worktree_lease_rejects_workdir_directory_replacement() {
    let repo = TempRepo::new("wt-lease-workdir-aba");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-lease-workdir-aba");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview");

    // Rebuild the workdir at the same pathname with the same bytes: registration
    // and porcelain output are unchanged, the directory inode is not.
    StagedDirReplacement::stage(&linked.0)
        .expect("stage the workdir")
        .apply()
        .expect("swap in a workdir with the same contents and a new inode");

    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("a replaced workdir must invalidate the lease");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
    assert!(
        linked.0.exists(),
        "stale lease must not remove the worktree"
    );
    repo.git_ok(&["worktree", "remove", "--force", linked.as_str()]);
}

// Story 7: a prune between confirm and execute drops the registration, so the
// lease must fail closed rather than run a removal against a missing worktree.

#[test]
fn preview_remove_worktree_lease_rejects_concurrent_prune() {
    let repo = TempRepo::new("wt-lease-prune");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("a.txt"), "a\n").unwrap();
    repo.git_ok(&["add", "."]);
    repo.git_ok(&["commit", "-q", "-m", "init"]);

    let linked = LinkedDir::new("wt-lease-prune");
    repo.git_ok(&["worktree", "add", "-q", "--detach", linked.as_str()]);
    let preview = preview_remove_worktree(repo.path(), linked.as_str()).expect("preview");

    std::fs::remove_dir_all(&linked.0).expect("simulate the directory going away");
    repo.git_ok(&["worktree", "prune"]);

    let err = remove_worktree(repo.path(), linked.as_str(), &preview.expected_state)
        .expect_err("a pruned registration must invalidate the lease");
    assert!(
        err.contains("changed after this confirmation"),
        "got: {err}"
    );
}

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

#[test]
fn reset_preview_lists_commits_and_recovery_warning() {
    let repo = TempRepo::new("reset-preview");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git(&["commit", "-qam", "two"]);

    let preview = preview_reset(repo.path(), "HEAD~1", "hard", "HEAD").expect("preview");
    assert!(preview.summary.contains("hard"));
    assert!(preview.details.iter().any(|line| line.contains("two")));
    assert!(preview.warnings.iter().any(|line| line.contains("reflog")));
    assert!(
        preview
            .expected_state
            .as_deref()
            .is_some_and(|s| s.starts_with("v2:")),
        "hard preview must mint an exact-state lease"
    );
    assert_eq!(preview.target_oid, rev_parse(&repo, "HEAD~1"));
    let head = rev_parse(&repo, "HEAD");
    assert_eq!(preview.expected_source_oid.as_deref(), Some(head.as_str()));
}

#[test]
fn reset_preview_anchors_on_the_source_ref_not_head() {
    // A reset of a *non-current* branch (drag a branch onto a commit) checks
    // that branch out first, so the impacted commits are `target..source`,
    // not `target..HEAD`. The preview must reflect the branch being reset.
    let repo = TempRepo::new("reset-source-ref");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "base"]);
    // A feature branch with a commit that HEAD (main) does not have.
    repo.git(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(repo.0.join("f.txt"), b"feature\n").unwrap();
    repo.git(&["commit", "-qam", "feature-only"]);
    // Back on main so HEAD != the branch being reset.
    repo.git(&["checkout", "-q", "main"]);

    // Resetting `feature` to base must list feature-only, even though HEAD=main.
    let on_source = preview_reset(repo.path(), "main", "mixed", "feature").expect("preview source");
    assert!(on_source
        .details
        .iter()
        .any(|line| line.contains("feature-only")));
    // Anchored on HEAD (main) the same range is empty — proves the fix matters.
    let on_head = preview_reset(repo.path(), "main", "mixed", "HEAD").expect("preview head");
    assert!(!on_head
        .details
        .iter()
        .any(|line| line.contains("feature-only")));
}

#[test]
fn reset_preview_source_uses_branch_not_same_named_tag() {
    let repo = TempRepo::new("reset-ambig");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "one"]);
    // Branch `dup` carries an extra commit; tag `dup` stays at base (== main).
    repo.git(&["branch", "dup"]);
    repo.git(&["checkout", "-q", "dup"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git(&["commit", "-qam", "dup-only"]);
    repo.git(&["checkout", "-q", "main"]);
    repo.git(&["tag", "dup", "main"]);

    // Resetting branch `dup` to main: impact is main..refs/heads/dup = dup-only.
    // A bare `dup` would resolve to the tag (== main) and show nothing.
    let preview = preview_reset(repo.path(), "main", "mixed", "dup").expect("preview");
    assert!(
        preview.details.iter().any(|line| line.contains("dup-only")),
        "reset source must resolve to the branch, not the same-named tag: {:?}",
        preview.details
    );
}

#[test]
fn reset_preview_target_uses_branch_not_same_named_tag() {
    // The preview is now the only place an ambiguous target is qualified to
    // refs/heads/ — the write executes the oid resolved here — so this is what
    // stops the confirm dialog describing the tag while the reset lands on the
    // branch (GL-120 review; sole owner of the qualification since GL-302).
    let repo = TempRepo::new("reset-target-ambig");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "one"]);
    let base_short = rev_parse(&repo, "HEAD")[..7].to_string();
    // Branch `dup` carries an extra commit; tag `dup` stays at base.
    repo.git(&["branch", "dup"]);
    repo.git(&["checkout", "-q", "dup"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git(&["commit", "-qam", "dup-only"]);
    let dup_tip_short = rev_parse(&repo, "HEAD")[..7].to_string();
    repo.git(&["checkout", "-q", "main"]);
    repo.git(&["tag", "dup", "main"]);

    // Resetting HEAD (main, at base) to `dup`: the target must resolve to the
    // branch tip, so the preview says HEAD moves there — not to the tag at base.
    let preview = preview_reset(repo.path(), "dup", "mixed", "HEAD").expect("preview");
    assert!(
        preview
            .details
            .iter()
            .any(|line| line.contains(&dup_tip_short)),
        "preview target must resolve to the branch tip {dup_tip_short}, not the tag: {:?}",
        preview.details
    );
    assert!(
        !preview
            .details
            .iter()
            .any(|line| line.contains(&format!("move to {base_short}"))),
        "preview must not describe moving to the same-named tag at base {base_short}: {:?}",
        preview.details
    );
}

#[test]
fn reset_preview_fails_closed_on_unresolvable_refs() {
    let repo = TempRepo::new("reset-bad-refs");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"base\n").unwrap();
    repo.git(&["add", "f.txt"]);
    repo.git(&["commit", "-qm", "base"]);

    // A bogus target or source must error (fail closed) rather than render a
    // confident empty preview.
    assert!(preview_reset(repo.path(), "does-not-exist", "mixed", "HEAD").is_err());
    assert!(preview_reset(repo.path(), "HEAD", "mixed", "does-not-exist").is_err());
}

#[test]
fn reset_preview_hard_lists_tracked_and_untracked_obstructions_only() {
    let repo = TempRepo::new("reset-hard-untracked");
    repo.git(&["init", "-q", "-b", "main"]);
    repo.git(&["config", "user.email", "t@t.t"]);
    repo.git(&["config", "user.name", "T"]);
    repo.git(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("tracked.txt"), b"one\n").unwrap();
    std::fs::write(repo.0.join("restored.txt"), b"target\n").unwrap();
    repo.git(&["add", "tracked.txt", "restored.txt"]);
    repo.git(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("tracked.txt"), b"two\n").unwrap();
    repo.git(&["rm", "-q", "restored.txt"]);
    repo.git(&["commit", "-am", "two"]);
    // Dirty the tree: a tracked edit is lost by --hard, an ordinary untracked
    // file is left in place, and an untracked file that blocks a target-tree
    // tracked path can be overwritten/deleted by reset --hard.
    std::fs::write(repo.0.join("tracked.txt"), b"dirty\n").unwrap();
    std::fs::write(repo.0.join("untracked.txt"), b"keep\n").unwrap();
    std::fs::write(repo.0.join(".git/info/exclude"), b"restored.txt\n").unwrap();
    std::fs::write(repo.0.join("restored.txt"), b"obstruct\n").unwrap();

    let preview = preview_reset(repo.path(), "HEAD~1", "hard", "HEAD").expect("preview");
    let warnings = preview.warnings.join("\n");
    assert!(warnings.contains("tracked changes that will be lost"));
    assert!(warnings.contains("tracked.txt"));
    let full = format!(
        "{}{}",
        preview.details.join("\n"),
        preview.warnings.join("\n")
    );
    assert!(
        full.contains("restored.txt"),
        "hard-reset preview must list ignored/untracked target obstructions: {full}"
    );
    assert!(
        !full.contains("untracked.txt"),
        "hard-reset preview must not list ordinary untracked files: {full}"
    );
}

#[test]
fn hard_reset_rejects_worktree_drift_before_mutating() {
    let repo = TempRepo::new("hard-reset-stale-worktree");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["commit", "-qam", "two"]);
    std::fs::write(repo.0.join("f.txt"), b"dirty\n").unwrap();
    let target = rev_parse(&repo, "HEAD~1");
    let source = rev_parse(&repo, "HEAD");
    let preview = preview_reset(repo.path(), &target, "hard", "HEAD").expect("preview");

    std::fs::write(repo.0.join("f.txt"), b"drifted\n").unwrap();
    let error = reset_branch(
        repo.path(),
        Some("main"),
        Some(&source),
        &target,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("worktree drift must expire the lease");

    assert!(
        error.contains("changed after this confirmation"),
        "unexpected error: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("f.txt")).unwrap(),
        "drifted\n"
    );
    assert_eq!(rev_parse(&repo, "HEAD"), source);
}

#[test]
fn hard_reset_rejects_staged_drift_before_mutating() {
    let repo = TempRepo::new("hard-reset-stale-index");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["commit", "-qam", "two"]);
    let target = rev_parse(&repo, "HEAD~1");
    let source = rev_parse(&repo, "HEAD");
    let preview = preview_reset(repo.path(), &target, "hard", "HEAD").expect("preview");

    std::fs::write(repo.0.join("staged.txt"), b"new\n").unwrap();
    repo.git_ok(&["add", "staged.txt"]);
    let error = reset_branch(
        repo.path(),
        Some("main"),
        Some(&source),
        &target,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("index drift must expire the lease");

    assert!(
        error.contains("changed after this confirmation"),
        "unexpected error: {error}"
    );
    assert_eq!(rev_parse(&repo, "HEAD"), source);
    assert!(repo.0.join("staged.txt").exists());
}

#[test]
fn hard_reset_rejects_head_movement_before_mutating() {
    let repo = TempRepo::new("hard-reset-stale-head");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["commit", "-qam", "two"]);
    let target = rev_parse(&repo, "HEAD~1");
    let source = rev_parse(&repo, "HEAD");
    let preview = preview_reset(repo.path(), &target, "hard", "HEAD").expect("preview");

    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "three"]);
    let error = reset_branch(
        repo.path(),
        Some("main"),
        Some(&source),
        &target,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("HEAD movement must abort before hard reset");

    // Tip CAS runs before the mutation-boundary lease check, so a moved branch
    // fails closed on the expected-oid probe.
    assert!(
        error.contains("changed from") || error.contains("Refresh and try again"),
        "unexpected error: {error}"
    );
    assert_ne!(rev_parse(&repo, "HEAD"), target);
}

#[test]
fn hard_reset_revalidates_path_observations_after_the_content_pass() {
    // Fingerprinting a set of files is not atomic. A leaf hashed early can be
    // rewritten while later leaves are still being read, and the token would
    // then carry its pre-edit digest — so only the cheap observation sweep at
    // the end of the pass can catch it. Same-size content keeps length and mode
    // identical, leaving inode/timestamps as the only signal.
    let repo = TempRepo::new("hard-reset-leaf-recheck");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["commit", "-qam", "two"]);
    let target = rev_parse(&repo, "HEAD~1");
    // Dirty, so it is fingerprinted and would be destroyed by the reset.
    std::fs::write(repo.0.join("f.txt"), b"dirty\n").unwrap();

    let preview = preview_reset(repo.path(), &target, "hard", "HEAD").expect("preview");

    let edited = repo.0.join("f.txt");
    set_hard_reset_after_fingerprint_test_hook(move || {
        // Same byte length, after this path was hashed in the boundary capture.
        std::fs::write(&edited, b"LATE!\n").unwrap();
    });

    let error = reset_branch(
        repo.path(),
        Some("main"),
        preview.expected_source_oid.as_deref(),
        &preview.target_oid,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("the observation sweep must reject an edit made after hashing");
    assert!(
        error.contains("changed after this confirmation"),
        "unexpected error: {error}"
    );
    assert_eq!(
        std::fs::read(repo.0.join("f.txt")).unwrap(),
        b"LATE!\n",
        "the late edit must survive — nothing may be reset"
    );
}

#[test]
fn hard_reset_mutates_the_validated_scope_after_a_late_gitfile_retarget() {
    // Validation proves one gitdir/worktree pair; the reset must then run
    // pinned to it. Retargeting the gitfile in the window between the two would
    // otherwise let git re-resolve the scope and reset somewhere unleased.
    let main = TempRepo::new("hard-reset-late-retarget-main");
    main.git_ok(&["init", "-q", "-b", "main"]);
    main.git_ok(&["config", "user.email", "t@t.t"]);
    main.git_ok(&["config", "user.name", "T"]);
    main.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(main.0.join("f.txt"), b"one\n").unwrap();
    main.git_ok(&["add", "f.txt"]);
    main.git_ok(&["commit", "-qm", "one"]);
    std::fs::write(main.0.join("f.txt"), b"two\n").unwrap();
    main.git_ok(&["commit", "-qam", "two"]);
    main.git_ok(&["branch", "feature"]);
    let linked = TempRepo::new("hard-reset-late-retarget-wt");
    std::fs::remove_dir_all(&linked.0).unwrap();
    main.git_ok(&["worktree", "add", "-q", linked.path(), "feature"]);

    let target = rev_parse(&main, "main~1");
    let source = rev_parse(&linked, "HEAD");
    let preview = preview_reset(linked.path(), &target, "hard", "HEAD").expect("preview");

    let decoy = TempRepo::new("hard-reset-late-retarget-decoy");
    decoy.git_ok(&["init", "-q", "-b", "main"]);
    decoy.git_ok(&["config", "user.email", "t@t.t"]);
    decoy.git_ok(&["config", "user.name", "T"]);
    decoy.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(decoy.0.join("f.txt"), b"decoy\n").unwrap();
    decoy.git_ok(&["add", "f.txt"]);
    decoy.git_ok(&["commit", "-qm", "decoy"]);
    let gitfile = linked.0.join(".git");
    let original = std::fs::read(&gitfile).unwrap();
    let decoy_gitdir = decoy.0.join(".git").canonicalize().unwrap();
    let gitfile_for_hook = gitfile.clone();
    // Retarget AFTER the lease validated — too late for the lease to catch.
    set_hard_reset_after_validation_test_hook(move || {
        std::fs::write(
            &gitfile_for_hook,
            format!("gitdir: {}\n", decoy_gitdir.display()),
        )
        .unwrap();
    });

    let result = reset_branch(
        linked.path(),
        Some("feature"),
        Some(&source),
        &target,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    );
    std::fs::write(&gitfile, original).unwrap();
    result.expect("the reset runs in the scope the lease validated");
    assert_eq!(
        std::fs::read_to_string(linked.0.join("f.txt")).unwrap(),
        "one\n",
        "the leased worktree must be the one that was reset"
    );
    assert_eq!(
        std::fs::read_to_string(decoy.0.join("f.txt")).unwrap(),
        "decoy\n",
        "the retargeted repository must be untouched"
    );
}

#[test]
fn hard_reset_rejects_linked_worktree_scope_retarget() {
    let main = TempRepo::new("hard-reset-linked-main");
    main.git_ok(&["init", "-q", "-b", "main"]);
    main.git_ok(&["config", "user.email", "t@t.t"]);
    main.git_ok(&["config", "user.name", "T"]);
    main.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(main.0.join("f.txt"), b"one\n").unwrap();
    main.git_ok(&["add", "f.txt"]);
    main.git_ok(&["commit", "-qm", "one"]);
    std::fs::write(main.0.join("f.txt"), b"two\n").unwrap();
    main.git_ok(&["commit", "-qam", "two"]);
    main.git_ok(&["branch", "feature"]);
    let linked = TempRepo::new("hard-reset-linked-wt");
    std::fs::remove_dir_all(&linked.0).unwrap();
    main.git_ok(&["worktree", "add", "-q", linked.path(), "feature"]);
    std::fs::write(linked.0.join("f.txt"), b"dirty\n").unwrap();

    let target = rev_parse(&main, "main~1");
    let source = rev_parse(&linked, "HEAD");
    let preview = preview_reset(linked.path(), &target, "hard", "HEAD").expect("preview");
    let decoy = TempRepo::new("hard-reset-linked-decoy");
    decoy.git_ok(&["init", "-q", "-b", "main"]);
    decoy.git_ok(&["config", "user.email", "t@t.t"]);
    decoy.git_ok(&["config", "user.name", "T"]);
    decoy.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(decoy.0.join("f.txt"), b"decoy\n").unwrap();
    decoy.git_ok(&["add", "f.txt"]);
    decoy.git_ok(&["commit", "-qm", "decoy"]);
    let gitfile = linked.0.join(".git");
    let original = std::fs::read(&gitfile).unwrap();
    let decoy_gitdir = decoy.0.join(".git").canonicalize().unwrap();
    let gitfile_for_hook = gitfile.clone();
    // Retarget after tip preparation so the mutation-boundary lease check is
    // what rejects the replaced repository scope.
    set_hard_reset_before_mutation_test_hook(move || {
        std::fs::write(
            &gitfile_for_hook,
            format!("gitdir: {}\n", decoy_gitdir.display()),
        )
        .unwrap();
    });

    let result = reset_branch(
        linked.path(),
        Some("feature"),
        Some(&source),
        &target,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    );
    std::fs::write(&gitfile, original).unwrap();
    let error = result.expect_err("retargeted gitfile must invalidate the lease");
    // The retarget breaks the re-capture itself rather than producing a
    // mismatch, so this is the "could not verify" wording, not the stale one.
    assert!(
        error.contains("was not performed"),
        "unexpected error: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(linked.0.join("f.txt")).unwrap(),
        "dirty\n"
    );
    main.git_ok(&["worktree", "remove", "--force", linked.path()]);
}

#[test]
fn hard_reset_rejects_non_current_source_without_switching() {
    let (repo, base) = repo_with_base_commit("hard-reset-no-switch");
    repo.git_ok(&["branch", "other"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "advance"]);
    let other_tip = rev_parse(&repo, "other");
    let active = String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout)
        .trim()
        .to_string();
    assert_eq!(active, "main");

    // Preview while on `other` so the lease matches that worktree, then switch
    // away before execute — hard reset must refuse rather than `git switch`.
    repo.git_ok(&["checkout", "-q", "other"]);
    let preview = preview_reset(repo.path(), &base, "hard", "other").expect("preview");
    repo.git_ok(&["checkout", "-q", "main"]);
    let main_before = rev_parse(&repo, "main");
    let dirty = repo.0.join("keep.txt");
    std::fs::write(&dirty, b"precious\n").unwrap();

    let error = reset_branch(
        repo.path(),
        Some("other"),
        Some(&other_tip),
        &base,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("hard reset must not switch branches to reach the source");
    assert!(
        error.contains("already be checked out"),
        "unexpected error: {error}"
    );
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout).trim(),
        "main",
        "failed hard reset must leave HEAD on the original branch"
    );
    assert_eq!(rev_parse(&repo, "main"), main_before);
    assert_eq!(rev_parse(&repo, "other"), other_tip);
    assert_eq!(std::fs::read_to_string(&dirty).unwrap(), "precious\n");
}

#[test]
fn hard_reset_preview_rejects_non_current_source() {
    let (repo, base) = repo_with_base_commit("hard-reset-preview-no-switch");
    repo.git_ok(&["branch", "other"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "advance"]);
    assert_eq!(
        String::from_utf8_lossy(&repo.git(&["branch", "--show-current"]).stdout).trim(),
        "main"
    );

    let error = preview_reset(repo.path(), &base, "hard", "other")
        .expect_err("hard preview must refuse a non-current source");
    assert!(
        error.contains("already be checked out"),
        "unexpected error: {error}"
    );
    // Soft/mixed may still preview a non-current source (execute checks it out).
    preview_reset(repo.path(), &base, "mixed", "other").expect("mixed preview of other");
}

#[test]
fn hard_reset_rejects_close_reopen_worktree_aba() {
    let main = TempRepo::new("hard-reset-close-reopen-main");
    main.git_ok(&["init", "-q", "-b", "main"]);
    main.git_ok(&["config", "user.email", "t@t.t"]);
    main.git_ok(&["config", "user.name", "T"]);
    main.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(main.0.join("f.txt"), b"one\n").unwrap();
    main.git_ok(&["add", "f.txt"]);
    main.git_ok(&["commit", "-qm", "one"]);
    std::fs::write(main.0.join("f.txt"), b"two\n").unwrap();
    main.git_ok(&["commit", "-qam", "two"]);
    main.git_ok(&["branch", "feature"]);

    let linked = TempRepo::new("hard-reset-close-reopen-wt");
    std::fs::remove_dir_all(&linked.0).unwrap();
    main.git_ok(&["worktree", "add", "-q", linked.path(), "feature"]);
    std::fs::write(linked.0.join("f.txt"), b"dirty\n").unwrap();

    let target = rev_parse(&main, "main~1");
    let source = rev_parse(&linked, "HEAD");
    let preview = preview_reset(linked.path(), &target, "hard", "HEAD").expect("preview");

    // Remove and recreate the worktree at the same path — content and tip match,
    // but directory identities (inodes) differ, so the lease must fail closed.
    // The staged copy is taken before the removal so the recreated workdir is
    // guaranteed a different inode: git's own remove/add cycle can be handed the
    // freed one straight back (see `StagedDirReplacement`).
    let replacement = StagedDirReplacement::stage(&linked.0).expect("stage the workdir");
    main.git_ok(&["worktree", "remove", "--force", linked.path()]);
    main.git_ok(&["worktree", "add", "-q", linked.path(), "feature"]);
    std::fs::write(linked.0.join("f.txt"), b"dirty\n").unwrap();
    replacement
        .apply()
        .expect("swap in a workdir with a new inode");

    let error = reset_branch(
        linked.path(),
        Some("feature"),
        Some(&source),
        &target,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("recreated worktree must invalidate scoped identities");
    assert!(
        error.contains("changed after this confirmation"),
        "unexpected error: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(linked.0.join("f.txt")).unwrap(),
        "dirty\n"
    );
    main.git_ok(&["worktree", "remove", "--force", linked.path()]);
}

#[test]
fn hard_reset_rejects_unstable_capture_aba() {
    let repo = TempRepo::new("hard-reset-unstable");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["commit", "-qam", "two"]);
    let target = rev_parse(&repo, "HEAD~1");
    let dirty = repo.0.join("f.txt");
    set_hard_reset_capture_test_hook(move || {
        std::fs::write(&dirty, b"mid-capture\n").unwrap();
    });
    let error = preview_reset(repo.path(), &target, "hard", "HEAD")
        .expect_err("mid-capture drift must fail closed");
    assert!(error.contains("changed while"), "unexpected error: {error}");
}

#[test]
fn hard_reset_uses_previewed_target_oid_not_moved_symbolic_name() {
    let repo = TempRepo::new("hard-reset-target-oid");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    let first = rev_parse(&repo, "HEAD");
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["commit", "-qam", "two"]);
    let second = rev_parse(&repo, "HEAD");
    repo.git_ok(&["branch", "target-ref", &first]);
    let preview = preview_reset(repo.path(), "target-ref", "hard", "HEAD").expect("preview");
    assert_eq!(preview.target_oid, first);

    // Move the symbolic name after preview; execute must still land on the leased oid.
    repo.git_ok(&["branch", "-f", "target-ref", &second]);
    reset_branch(
        repo.path(),
        Some("main"),
        preview.expected_source_oid.as_deref(),
        &preview.target_oid,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect("reset to leased oid");
    assert_eq!(rev_parse(&repo, "HEAD"), first);
}

#[test]
fn hard_reset_does_not_qualify_the_leased_oid_into_a_same_named_branch() {
    // Git permits a branch and a tag literally named after a 40-hex oid. A bare
    // oid still resolves to the object, but qualifying it to refs/heads/<oid>
    // would resolve to that branch's movable tip — so the leased oid must reach
    // `git reset --hard` unqualified.
    let repo = TempRepo::new("hard-reset-hex-named-ref");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    let first = rev_parse(&repo, "HEAD");
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["commit", "-qam", "two"]);
    let second = rev_parse(&repo, "HEAD");

    let preview = preview_reset(repo.path(), "HEAD~1", "hard", "HEAD").expect("preview");
    assert_eq!(preview.target_oid, first);

    // After the preview, plant the ambiguous pair pointing away from the target.
    repo.git_ok(&["branch", &first, &second]);
    repo.git_ok(&["tag", &first, &second]);

    reset_branch(
        repo.path(),
        Some("main"),
        preview.expected_source_oid.as_deref(),
        &preview.target_oid,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect("reset to leased oid");
    assert_eq!(
        rev_parse(&repo, "HEAD"),
        first,
        "reset must land on the leased oid, not refs/heads/<oid>"
    );
}

#[test]
fn mixed_reset_does_not_qualify_the_previewed_oid_into_a_same_named_branch() {
    // Soft/mixed carry the same previewed oid as hard, so they take the same
    // unqualified path — a branch named after the oid must not capture them.
    let repo = TempRepo::new("mixed-reset-hex-named-ref");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "one"]);
    let first = rev_parse(&repo, "HEAD");
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "two"]);
    let second = rev_parse(&repo, "HEAD");
    repo.git_ok(&["branch", &first, &second]);
    repo.git_ok(&["tag", &first, &second]);

    reset_branch(
        repo.path(),
        Some("main"),
        Some(&second),
        &first,
        "mixed",
        None,
        None,
        None,
    )
    .expect("reset to the previewed oid");
    assert_eq!(
        rev_parse(&repo, "HEAD"),
        first,
        "reset must land on the previewed oid, not refs/heads/<oid>"
    );
}

#[test]
fn reset_rejects_a_target_that_is_not_an_exact_oid() {
    // Soft/mixed carry no lease, so the write boundary is the only thing
    // standing between a ref name and `git reset` — hard mode additionally
    // expires its token, which binds the target string the preview resolved.
    let repo = TempRepo::new("reset-inexact-target");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    let first = rev_parse(&repo, "HEAD");
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["commit", "-qam", "two"]);
    let second = rev_parse(&repo, "HEAD");
    repo.git_ok(&["branch", "target-ref", &first]);

    let preview = preview_reset(repo.path(), "target-ref", "mixed", "HEAD").expect("preview");
    assert_eq!(preview.target_oid, first);

    // Hand the write the NAME the preview resolved, not the oid it returned.
    let error = reset_branch(
        repo.path(),
        Some("main"),
        preview.expected_source_oid.as_deref(),
        "target-ref",
        "mixed",
        None,
        None,
        None,
    )
    .expect_err("a ref name must not reach git reset");
    assert!(
        error.contains("exact commit id"),
        "unexpected error: {error}"
    );
    assert_eq!(
        rev_parse(&repo, "HEAD"),
        second,
        "the reset must be refused before any mutation"
    );
}

#[test]
fn hard_reset_leases_an_ignored_file_colliding_by_case_with_the_target() {
    // On a case-insensitive checkout an ignored FOO.txt and the target's
    // foo.txt are one filesystem entry, so the reset overwrites the ignored
    // file. Status omits ignored paths, so only obstruction detection can lease
    // it — and byte-exact matching missed the collision. `core.ignorecase` is
    // set explicitly so the test is deterministic on case-sensitive CI too.
    let repo = TempRepo::new("hard-reset-case-collision");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    repo.git_ok(&["config", "core.ignorecase", "true"]);
    repo.git_ok(&["commit", "-q", "--allow-empty", "-m", "base"]);
    std::fs::write(repo.0.join("foo.txt"), b"tracked\n").unwrap();
    repo.git_ok(&["add", "foo.txt"]);
    repo.git_ok(&["commit", "-qm", "adds foo"]);
    let target = rev_parse(&repo, "HEAD");
    repo.git_ok(&["rm", "-q", "foo.txt"]);
    repo.git_ok(&["commit", "-qm", "removes foo"]);
    std::fs::write(repo.0.join(".gitignore"), b"FOO.txt\n").unwrap();
    repo.git_ok(&["add", ".gitignore"]);
    repo.git_ok(&["commit", "-qm", "ignores FOO"]);
    // Ignored, so `git status` never reports it — the lease must pick it up as
    // an obstruction or not at all.
    std::fs::write(repo.0.join("FOO.txt"), b"ignored\n").unwrap();

    let preview = preview_reset(repo.path(), &target, "hard", "HEAD").expect("preview");
    std::fs::write(repo.0.join("FOO.txt"), b"edited after preview\n").unwrap();

    let error = reset_branch(
        repo.path(),
        Some("main"),
        preview.expected_source_oid.as_deref(),
        &preview.target_oid,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("editing the case-colliding obstruction must expire the lease");
    assert!(
        error.contains("changed after this confirmation"),
        "unexpected error: {error}"
    );
}

#[test]
fn hard_reset_rejects_drift_injected_before_mutation() {
    let repo = TempRepo::new("hard-reset-pre-mutation");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["commit", "-qam", "two"]);
    let target = rev_parse(&repo, "HEAD~1");
    let source = rev_parse(&repo, "HEAD");
    let preview = preview_reset(repo.path(), &target, "hard", "HEAD").expect("preview");
    let dirty = repo.0.join("f.txt");
    // Inject after tip/HEAD preparation and immediately before the final lease
    // re-capture that sits next to `git reset --hard`.
    set_hard_reset_before_mutation_test_hook(move || {
        std::fs::write(&dirty, b"late\n").unwrap();
    });
    let error = reset_branch(
        repo.path(),
        Some("main"),
        Some(&source),
        &target,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("pre-mutation drift must abort");
    assert!(
        error.contains("changed after this confirmation"),
        "unexpected error: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("f.txt")).unwrap(),
        "late\n"
    );
}

#[test]
fn hard_reset_rejects_ignored_target_obstruction_drift() {
    let repo = TempRepo::new("hard-reset-ignored-obstruction");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("tracked.txt"), b"one\n").unwrap();
    std::fs::write(repo.0.join("restored.txt"), b"target\n").unwrap();
    repo.git_ok(&["add", "tracked.txt", "restored.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    repo.git_ok(&["rm", "-q", "restored.txt"]);
    repo.git_ok(&["commit", "-am", "two"]);
    std::fs::write(repo.0.join(".git/info/exclude"), b"restored.txt\n").unwrap();
    std::fs::write(repo.0.join("restored.txt"), b"obstruct\n").unwrap();
    let target = rev_parse(&repo, "HEAD~1");
    let source = rev_parse(&repo, "HEAD");
    let preview = preview_reset(repo.path(), &target, "hard", "HEAD").expect("preview");
    assert!(
        preview.expected_state.is_some(),
        "hard preview must lease the ignored obstruction"
    );

    std::fs::write(repo.0.join("restored.txt"), b"changed after confirm\n").unwrap();
    let error = reset_branch(
        repo.path(),
        Some("main"),
        Some(&source),
        &target,
        "hard",
        preview.expected_state.as_deref(),
        preview.expected_head_branch.as_deref(),
        preview.expected_head_oid.as_deref(),
    )
    .expect_err("ignored obstruction drift must expire the lease");
    assert!(
        error.contains("changed after this confirmation"),
        "unexpected error: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("restored.txt")).unwrap(),
        "changed after confirm\n"
    );
}

#[test]
fn hard_reset_preview_rejects_active_replace_refs() {
    let repo = TempRepo::new("hard-reset-replace-refs");
    repo.git_ok(&["init", "-q", "-b", "main"]);
    repo.git_ok(&["config", "user.email", "t@t.t"]);
    repo.git_ok(&["config", "user.name", "T"]);
    repo.git_ok(&["config", "commit.gpgsign", "false"]);
    std::fs::write(repo.0.join("f.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "f.txt"]);
    repo.git_ok(&["commit", "-qm", "one"]);
    std::fs::write(repo.0.join("f.txt"), b"two\n").unwrap();
    repo.git_ok(&["commit", "-qam", "two"]);
    let first = rev_parse(&repo, "HEAD~1");
    let second = rev_parse(&repo, "HEAD");
    repo.git_ok(&["replace", &second, &first]);

    let error = preview_reset(repo.path(), &first, "hard", "HEAD")
        .expect_err("active replacement refs must fail closed");
    assert!(
        error.contains("replacement refs"),
        "unexpected error: {error}"
    );
}
