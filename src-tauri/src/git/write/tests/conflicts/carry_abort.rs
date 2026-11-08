//! Aborting a worktree-handoff carry: what is saved, and when nothing is touched.

use std::path::Path;

use super::super::super::cli::run_git_with_index_file;
use super::super::support::*;
use crate::git::types::{CapturedIdentity, OperationKind};

const BACKUP_NAME: &str = "GitLane: carry abort backup";

fn stash_lines(repo: &TempRepo) -> Vec<String> {
    String::from_utf8_lossy(&repo.git(&["stash", "list"]).stdout)
        .lines()
        .map(str::to_string)
        .collect()
}

fn in_backup(repo: &TempRepo, file: &str) -> String {
    let shown = repo.git(&["show", &format!("stash@{{0}}:{file}")]);
    assert!(shown.status.success(), "{file} is not in the backup");
    String::from_utf8_lossy(&shown.stdout).into_owned()
}

fn abort(repo: &TempRepo) -> String {
    abort_operation(repo.path(), OperationKind::Carry).expect("abort carry")
}

fn assert_backup_on_top(repo: &TempRepo) {
    let stashes = stash_lines(repo);
    assert_eq!(stashes.len(), 2, "{stashes:?}");
    assert!(stashes[0].contains(BACKUP_NAME), "{stashes:?}");
}

#[test]
fn a_moved_head_ends_the_carry_without_changing_anything() {
    let (repo, _linked, _) = handoff_into_conflict("carry-abort-moved");
    std::fs::write(repo.0.join("file.txt"), "resolved\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-qm", "resolved by hand"]);
    std::fs::write(repo.0.join("file.txt"), "kept edit\n").unwrap();

    let done = abort(&repo);

    assert!(done.contains("no files changed"), "{done}");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("file.txt")).unwrap(),
        "kept edit\n"
    );
    assert_eq!(stash_lines(&repo).len(), 1);
    let after = crate::git::conflicts::operation_status(repo.path()).unwrap();
    assert_eq!(after.kind, OperationKind::None);
}

#[test]
fn later_tracked_edits_land_in_the_backup_and_re_apply() {
    let (repo, _linked, _) = handoff_into_conflict("carry-abort-edits");
    std::fs::write(repo.0.join("file.txt"), "later edit\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);

    let done = abort(&repo);

    assert!(done.contains(BACKUP_NAME), "{done}");
    assert_backup_on_top(&repo);
    assert_eq!(in_backup(&repo, "file.txt"), "later edit\n");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("file.txt")).unwrap(),
        "feature\n"
    );
    repo.git_ok(&["stash", "apply", "stash@{0}"]);
    assert_eq!(
        std::fs::read_to_string(repo.0.join("file.txt")).unwrap(),
        "later edit\n"
    );
}

#[test]
fn a_file_staged_after_the_carry_is_in_the_backup() {
    let (repo, _linked, _) = handoff_into_conflict("carry-abort-staged");
    std::fs::write(repo.0.join("new.txt"), "brand new\n").unwrap();
    repo.git_ok(&["add", "new.txt"]);

    abort(&repo);

    assert_backup_on_top(&repo);
    assert_eq!(in_backup(&repo, "new.txt"), "brand new\n");
    assert!(!repo.0.join("new.txt").exists());
}

#[test]
fn unmerged_entries_are_backed_up_with_their_conflict_markers() {
    let (repo, _linked, _) = handoff_into_conflict("carry-abort-unmerged");

    abort(&repo);

    assert_backup_on_top(&repo);
    assert!(in_backup(&repo, "file.txt").contains("<<<<<<<"));
    assert!(repo.git(&["ls-files", "-u"]).stdout.is_empty());
}

#[test]
fn a_tree_matching_head_creates_no_backup() {
    let (repo, _linked, _) = handoff_into_conflict("carry-abort-clean");
    repo.git_ok(&["checkout", "HEAD", "--", "file.txt"]);

    let done = abort(&repo);

    assert!(!done.contains(BACKUP_NAME), "{done}");
    assert_eq!(stash_lines(&repo).len(), 1);
}

#[test]
fn a_staged_version_that_differs_from_the_file_is_kept() {
    let (repo, _linked, _) = handoff_into_conflict("carry-abort-staged-differs");
    std::fs::write(repo.0.join("file.txt"), "staged\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    std::fs::write(repo.0.join("file.txt"), "edited further\n").unwrap();

    abort(&repo);

    assert_backup_on_top(&repo);
    assert_eq!(in_backup(&repo, "file.txt"), "edited further\n");
    let staged = repo.git(&["show", "stash@{0}^2:file.txt"]);
    assert_eq!(String::from_utf8_lossy(&staged.stdout), "staged\n");
}

#[test]
fn staged_work_is_backed_up_when_the_file_matches_head() {
    let (repo, _linked, _) = handoff_into_conflict("carry-abort-staged-reverted");
    std::fs::write(repo.0.join("file.txt"), "staged\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    std::fs::write(repo.0.join("file.txt"), "feature\n").unwrap();

    abort(&repo);

    assert_backup_on_top(&repo);
    let staged = repo.git(&["show", "stash@{0}^2:file.txt"]);
    assert_eq!(String::from_utf8_lossy(&staged.stdout), "staged\n");
}

#[test]
fn a_warning_from_rev_parse_is_not_read_as_a_moved_head() {
    let (repo, _linked, _) = handoff_into_conflict("carry-abort-ambiguous-head");
    let head = rev_parse(&repo, "HEAD");
    repo.git_ok(&["update-ref", "refs/heads/HEAD", &head]);

    let done = abort(&repo);

    assert!(!done.contains("no files changed"), "{done}");
    assert_backup_on_top(&repo);
}

#[test]
fn a_failed_reset_keeps_the_carry_and_a_retry_stores_one_backup() {
    let (repo, _linked, _) = handoff_into_conflict("carry-abort-retry");
    let lock = repo.0.join(".git/index.lock");
    std::fs::write(&lock, "").unwrap();

    for _ in 0..2 {
        abort_operation(repo.path(), OperationKind::Carry).expect_err("the reset must fail");
    }

    assert_backup_on_top(&repo);
    assert!(repo.0.join(".git/gitlane-handoff").exists());
    std::fs::remove_file(&lock).unwrap();
    abort(&repo);
    assert_backup_on_top(&repo);
    assert!(!repo.0.join(".git/gitlane-handoff").exists());
}

#[test]
fn a_linked_destination_backs_up_from_its_own_index() {
    let (repo, linked) = repo_with_feature_worktree("carry-abort-linked");
    let oid = |rev: &str| {
        let out = git_at(&linked.0, &["rev-parse", rev]);
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    std::fs::write(linked.0.join("file.txt"), "wip\n").unwrap();
    git_ok_at(&linked.0, &["stash", "-q"]);
    std::fs::write(linked.0.join("file.txt"), "branch\n").unwrap();
    git_ok_at(&linked.0, &["commit", "-qam", "branch change"]);
    let applied = git_at(&linked.0, &["stash", "apply", "-q"]);
    assert!(!applied.status.success(), "the apply must conflict");
    let git_dir = oid("--absolute-git-dir");
    let git_dir = Path::new(&git_dir);
    crate::git::handoff::write_marker(git_dir, &[&oid("stash@{0}")], Some(&oid("HEAD"))).unwrap();

    abort_operation(linked.as_str(), OperationKind::Carry).expect("abort carry");

    assert_backup_on_top(&repo);
    assert!(in_backup(&repo, "file.txt").contains("<<<<<<<"));
    assert_eq!(
        std::fs::read_to_string(linked.0.join("file.txt")).unwrap(),
        "branch\n"
    );
    let leftovers = std::fs::read_dir(git_dir)
        .unwrap()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().contains("carry-abort"))
        .count();
    assert_eq!(leftovers, 0);
}

#[test]
fn a_marker_from_an_older_build_still_gets_a_backup() {
    let (repo, _linked, _) = handoff_into_conflict("carry-abort-old-marker");
    let marker = repo.0.join(".git/gitlane-handoff");
    let text = std::fs::read_to_string(&marker).unwrap();
    let old: Vec<&str> = text.lines().filter(|l| !l.starts_with("head ")).collect();
    assert_eq!(old.len(), text.lines().count() - 1, "no head line: {text}");
    std::fs::write(&marker, old.join("\n")).unwrap();

    abort(&repo);

    assert_backup_on_top(&repo);
    assert_eq!(
        std::fs::read_to_string(repo.0.join("file.txt")).unwrap(),
        "feature\n"
    );
}

#[test]
fn continuing_a_carry_ignores_the_head_line() {
    let (repo, _linked, _) = handoff_into_conflict("carry-continue-head-line");
    std::fs::write(repo.0.join("file.txt"), "resolved\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);

    continue_operation(
        repo.path(),
        OperationKind::Carry,
        None,
        None,
        &CapturedIdentity::NotCaptured,
    )
    .expect("finish carry");

    assert!(stash_lines(&repo).is_empty());
    assert!(!repo.0.join(".git/gitlane-handoff").exists());
}

#[test]
fn the_index_file_runner_leaves_the_real_index_alone() {
    let (repo, _) = repo_with_base_commit("carry-index-runner");
    let tracked = repo.git(&["ls-files"]);
    let tracked = String::from_utf8_lossy(&tracked.stdout);
    let file = tracked.lines().next().expect("a tracked file");
    std::fs::write(repo.0.join(file), "changed\n").unwrap();
    let real = repo.0.join(".git/index");
    let before = std::fs::read(&real).unwrap();
    let copy = repo.0.join(".git/test-index-copy");
    std::fs::copy(&real, &copy).unwrap();
    let copy: &Path = &copy;

    run_git_with_index_file(repo.path(), copy, &["add", "-u"]).expect("add");
    let tree = run_git_with_index_file(repo.path(), copy, &["write-tree"]).expect("write-tree");

    assert_ne!(tree.trim(), rev_parse(&repo, "HEAD^{tree}"));
    assert_eq!(std::fs::read(&real).unwrap(), before);
    assert!(repo.git(&["diff", "--cached"]).stdout.is_empty());
}
