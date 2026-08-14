//! Line-level staging, including the no-newline-at-eof marker it preserves.

use super::super::support::*;

#[test]
fn apply_line_stages_one_added_line_with_unusual_path() {
    let repo = TempRepo::new("stage-line-add-unusual-path");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    let file = "line space ü #.txt";
    std::fs::write(repo.0.join(file), "one\ntwo\nthree\nfour\n").unwrap();
    repo.git_ok(&["add", file]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join(file), "one\ntwo\ninserted\nthree\nfour\n").unwrap();

    apply_line(
        repo.path(),
        file,
        false,
        0,
        2,
        "add",
        "inserted",
        None,
        Some(3),
    )
    .expect("stage added line");

    let cached = repo.git(&["diff", "--cached", "--", file]);
    let cached_text = String::from_utf8_lossy(&cached.stdout);
    assert!(cached_text.contains("+inserted"));
    let unstaged = repo.git(&["diff", "--", file]);
    let unstaged_text = String::from_utf8_lossy(&unstaged.stdout);
    assert!(!unstaged_text.contains("+inserted"));
}

#[test]
fn apply_line_stages_one_deleted_line() {
    let repo = TempRepo::new("stage-line-delete");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\nthree\nfour\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\nfour\n").unwrap();

    apply_line(
        repo.path(),
        "file.txt",
        false,
        0,
        2,
        "del",
        "three",
        Some(3),
        None,
    )
    .expect("stage deleted line");

    let cached = repo.git(&["diff", "--cached", "--", "file.txt"]);
    assert!(String::from_utf8_lossy(&cached.stdout).contains("-three"));
    let unstaged = repo.git(&["diff", "--", "file.txt"]);
    assert!(!String::from_utf8_lossy(&unstaged.stdout).contains("-three"));
}

#[test]
fn apply_line_unstages_one_staged_line() {
    let repo = TempRepo::new("unstage-line");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\nthree\nfour\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\ninserted\nthree\nfour\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);

    apply_line(
        repo.path(),
        "file.txt",
        true,
        0,
        2,
        "add",
        "inserted",
        None,
        Some(3),
    )
    .expect("unstage added line");

    let cached = repo.git(&["diff", "--cached", "--", "file.txt"]);
    assert!(!String::from_utf8_lossy(&cached.stdout).contains("+inserted"));
    let unstaged = repo.git(&["diff", "--", "file.txt"]);
    assert!(String::from_utf8_lossy(&unstaged.stdout).contains("+inserted"));
}

#[test]
fn apply_line_rejects_stale_line_state() {
    let repo = TempRepo::new("stale-line");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\nthree\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join("file.txt"), "one\ntwo\ninserted\nthree\n").unwrap();

    let err = apply_line(
        repo.path(),
        "file.txt",
        false,
        0,
        2,
        "add",
        "different",
        None,
        Some(3),
    )
    .unwrap_err();

    assert!(err.contains("changed on disk"));
}

#[test]
fn apply_line_preserves_no_newline_at_eof_marker() {
    let repo = TempRepo::new("stage-line-no-newline");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), b"one\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join("file.txt"), b"one\nlast").unwrap();

    apply_line(
        repo.path(),
        "file.txt",
        false,
        0,
        1,
        "add",
        "last",
        None,
        Some(2),
    )
    .expect("stage no-newline line");

    let blob = repo.git(&["show", ":file.txt"]);
    assert_eq!(blob.stdout, b"one\nlast");
}
