//! Mid-history squash (replay) tests.

use super::support::*;

/// `base ─ one ─ two ─ three ─ four` on `main`, each commit rewriting `f.txt`
/// and adding a file of its own. Returns the repo plus the four commit oids
/// oldest-first.
fn linear_history(tag: &str) -> (TempRepo, Vec<String>) {
    let (repo, _base) = repo_with_base_commit(tag);
    let mut oids = Vec::new();
    for name in ["one", "two", "three", "four"] {
        std::fs::write(repo.0.join("f.txt"), format!("{name}\n")).unwrap();
        std::fs::write(repo.0.join(format!("{name}.txt")), format!("{name}\n")).unwrap();
        repo.git_ok(&["add", "-A"]);
        repo.git_ok(&["commit", "-q", "-m", name]);
        oids.push(rev_parse(&repo, "HEAD"));
    }
    (repo, oids)
}

/// The write under test with its identity/signing arguments defaulted — every
/// test here exercises the range guards, not the identity contract.
fn squash(
    repo: &TempRepo,
    tip: &str,
    newest: &str,
    parent: &str,
    message: &str,
) -> Result<String, String> {
    squash_range(
        repo.path(),
        Some("main"),
        tip,
        newest,
        parent,
        message,
        "",
        None,
        None,
        None,
        false,
    )
}

#[test]
fn squashes_below_the_tip_and_replays_the_commits_above() {
    let (repo, oids) = linear_history("squash-range-basic");
    let (one, three) = (&oids[0], &oids[2]);
    let tip = oids[3].clone();
    let tip_tree = rev_parse(&repo, "HEAD^{tree}");

    // three = newest of the range, one = the parent to build on.
    squash(&repo, &tip, three, one, "two+three").expect("squash a range below the tip");

    // one ─ two+three ─ four, with the working tree untouched.
    let log = repo.git(&["log", "--format=%s", "--first-parent"]);
    let subjects: Vec<String> = String::from_utf8_lossy(&log.stdout)
        .lines()
        .map(str::to_string)
        .collect();
    assert_eq!(subjects, ["four", "two+three", "one", "base"]);
    assert_eq!(
        rev_parse(&repo, "HEAD^{tree}"),
        tip_tree,
        "replaying keeps every tree, so the tip content must not change"
    );
    assert_eq!(
        rev_parse(&repo, "HEAD~2"),
        *one,
        "the range's parent is kept"
    );
    assert_ne!(rev_parse(&repo, "HEAD"), tip, "the tip is a new commit");
    let status = repo.git(&["status", "--porcelain"]);
    assert!(
        String::from_utf8_lossy(&status.stdout).trim().is_empty(),
        "the index and worktree must be untouched by the rewrite"
    );
}

#[test]
fn squash_below_the_tip_keeps_uncommitted_work() {
    let (repo, oids) = linear_history("squash-range-dirty");
    std::fs::write(repo.0.join("wip.txt"), "staged\n").unwrap();
    repo.git_ok(&["add", "wip.txt"]);
    std::fs::write(repo.0.join("loose.txt"), "unstaged\n").unwrap();

    squash(&repo, &oids[3], &oids[2], &oids[0], "folded").expect("squash with dirty worktree");

    let cached = repo.git(&["diff", "--cached", "--name-only"]);
    assert_eq!(String::from_utf8_lossy(&cached.stdout).trim(), "wip.txt");
    assert!(repo.0.join("loose.txt").exists());
    assert!(
        !repo
            .git(&["cat-file", "-e", "HEAD:wip.txt"])
            .status
            .success(),
        "staged work must not be swallowed into the rewrite"
    );
}

#[test]
fn squash_below_the_tip_rejects_a_stale_tip() {
    let (repo, oids) = linear_history("squash-range-stale");
    let stale_tip = oids[2].clone();

    let error = squash(
        &repo, &stale_tip, // the caller saw an older tip than HEAD
        &oids[1], &oids[0], "folded",
    )
    .expect_err("a moved HEAD must abort the rewrite");
    assert!(!error.is_empty());
    assert_eq!(rev_parse(&repo, "HEAD"), oids[3], "history stays untouched");
}

#[test]
fn squash_below_the_tip_refuses_to_cross_a_merge() {
    let (repo, _merge) = repo_with_merged_feature("squash-range-merge");
    // The merge is HEAD; squashing anything under it would flatten its side
    // history into the replay.
    let first_parent = rev_parse(&repo, "HEAD^1");
    let grandparent = rev_parse(&repo, "HEAD^1^");
    std::fs::write(repo.0.join("after.txt"), "after\n").unwrap();
    repo.git_ok(&["add", "after.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "after the merge"]);
    let tip = rev_parse(&repo, "HEAD");

    let error = squash(&repo, &tip, &first_parent, &grandparent, "folded")
        .expect_err("a merge in the rewritten span must be refused");
    assert!(error.contains("merge"), "unexpected error: {error}");
    assert_eq!(rev_parse(&repo, "HEAD"), tip);
}

#[test]
fn squash_below_the_tip_refuses_pushed_commits() {
    let (repo, oids) = linear_history("squash-range-pushed");
    // Pretend `two` was published: a remote-tracking ref containing it.
    repo.git_ok(&["update-ref", "refs/remotes/origin/main", &oids[1]]);

    let error = squash(&repo, &oids[3], &oids[2], &oids[0], "folded")
        .expect_err("rewriting published history must be refused");
    assert!(error.contains("pushed"), "unexpected error: {error}");
    assert_eq!(rev_parse(&repo, "HEAD"), oids[3]);
}

/// GL-372 review: `parent_oid` is an operand, not a proof. `A..B` means
/// "reachable from B, not from A" — an unrelated commit excludes nothing, so a
/// range built from one covers the branch's whole history. Without the chain
/// walk this rewrote every commit onto the stranger and left the real history
/// reachable only through the reflog.
#[test]
fn squash_below_the_tip_refuses_a_parent_that_is_not_an_ancestor() {
    let (repo, oids) = linear_history("squash-range-unrelated-parent");
    repo.git_ok(&["checkout", "-q", "--orphan", "side"]);
    repo.git_ok(&["rm", "-rq", "--cached", "."]);
    std::fs::write(repo.0.join("side.txt"), "side\n").unwrap();
    repo.git_ok(&["add", "side.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "unrelated"]);
    let unrelated = rev_parse(&repo, "HEAD");
    repo.git_ok(&["checkout", "-qf", "main"]);

    let error = squash(&repo, &oids[3], &oids[2], &unrelated, "folded")
        .expect_err("a parent outside the first-parent chain must be refused");
    assert!(
        error.contains("first-parent range"),
        "unexpected error: {error}"
    );
    assert_eq!(rev_parse(&repo, "HEAD"), oids[3], "history stays untouched");
}

/// A merge whose second parent is already reachable adds no commits, so the old
/// count comparison saw a linear span and replay silently dropped the merge link.
#[test]
fn squash_below_the_tip_refuses_a_merge_that_adds_no_commits() {
    let (repo, oids) = linear_history("squash-range-degenerate-merge");
    // `git merge --no-ff` of an ancestor is a no-op, so fabricate the merge:
    // a commit whose second parent is already reachable through its first.
    let merge = String::from_utf8(
        repo.git(&[
            "commit-tree",
            "HEAD^{tree}",
            "-p",
            "HEAD",
            "-p",
            &oids[2],
            "-m",
            "redundant merge",
        ])
        .stdout,
    )
    .unwrap()
    .trim()
    .to_string();
    repo.git_ok(&["update-ref", "refs/heads/main", &merge]);
    std::fs::write(repo.0.join("after.txt"), "after\n").unwrap();
    repo.git_ok(&["add", "after.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "after"]);
    let tip = rev_parse(&repo, "HEAD");

    let error = squash(&repo, &tip, &oids[2], &oids[0], "folded")
        .expect_err("a merge commit in the span must be refused however few commits it adds");
    assert!(error.contains("merge"), "unexpected error: {error}");
    assert_eq!(rev_parse(&repo, "HEAD"), tip);
}

/// Commit order must come from ancestry, not commit dates: a tip backdated
/// behind the commits it sits on top of must still be replayed last.
#[test]
fn squash_below_the_tip_replays_by_ancestry_not_by_date() {
    let (repo, oids) = linear_history("squash-range-backdated");
    repo.git(&[
        "commit",
        "-q",
        "--amend",
        "--no-edit",
        "--date=2001-01-01T00:00:00+00:00",
    ]);
    let tip = rev_parse(&repo, "HEAD");

    squash(&repo, &tip, &oids[2], &oids[0], "two+three")
        .expect("a backdated tip must still replay on top");

    let log = repo.git(&["log", "--format=%s", "--first-parent"]);
    let subjects: Vec<String> = String::from_utf8_lossy(&log.stdout)
        .lines()
        .map(str::to_string)
        .collect();
    assert_eq!(subjects, ["four", "two+three", "one", "base"]);
}

/// The replay rebuilds each message rather than copying the commit object, so
/// non-ASCII text and authors have to survive that round trip intact. (An
/// *undecodable* message is refused outright in `read_replay`; git transcodes on
/// output, so it cannot be staged through the CLI to test here.)
#[test]
fn squash_below_the_tip_preserves_unicode_messages_and_authors() {
    let (repo, oids) = linear_history("squash-range-unicode");
    repo.git_ok(&[
        "-c",
        "user.name=Ünïcode Añtor",
        "-c",
        "user.email=u@example.test",
        "commit",
        "-q",
        "--amend",
        "--reset-author",
        "-m",
        "fix: résumé — naïve ✨\n\nbody with émoji 🎉",
    ]);
    let tip = rev_parse(&repo, "HEAD");

    squash(&repo, &tip, &oids[2], &oids[0], "folded").expect("squash below the tip");

    let head = repo.git(&["log", "-1", "--format=%B%x00%an%x00%ae", "HEAD"]);
    let out = String::from_utf8_lossy(&head.stdout);
    let mut fields = out.split('\0');
    assert_eq!(
        fields.next().unwrap().trim_end(),
        "fix: résumé — naïve ✨\n\nbody with émoji 🎉"
    );
    assert_eq!(fields.next().unwrap(), "Ünïcode Añtor");
    assert_eq!(fields.next().unwrap().trim_end(), "u@example.test");
}

/// `git reset --hard ORIG_HEAD` is the undo people reach for after a squash;
/// moving a ref directly does not set it, so this path does it explicitly.
#[test]
fn squash_below_the_tip_leaves_the_old_tip_in_orig_head() {
    let (repo, oids) = linear_history("squash-range-orig-head");
    let tip = oids[3].clone();

    squash(&repo, &tip, &oids[2], &oids[0], "folded").expect("squash below the tip");

    assert_eq!(rev_parse(&repo, "ORIG_HEAD"), tip);
    repo.git_ok(&["reset", "--hard", "-q", "ORIG_HEAD"]);
    assert_eq!(
        rev_parse(&repo, "HEAD"),
        tip,
        "ORIG_HEAD must undo the squash"
    );
}
