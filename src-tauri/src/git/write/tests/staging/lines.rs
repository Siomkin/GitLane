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
        &ApplyLineRequest {
            expected_new_no: Some(3),
            ..ApplyLineRequest::test(file, false, 2, "add", "inserted")
        },
    )
    .expect("stage added line");

    let blob = repo.git(&["show", &format!(":{file}")]);
    assert_eq!(
        String::from_utf8_lossy(&blob.stdout),
        "one\ntwo\ninserted\nthree\nfour\n",
        "the staged line lands where it was displayed"
    );
    let unstaged = repo.git(&["diff", "--", file]);
    assert!(String::from_utf8_lossy(&unstaged.stdout).is_empty());
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
        &ApplyLineRequest {
            expected_old_no: Some(3),
            ..ApplyLineRequest::test("file.txt", false, 2, "del", "three")
        },
    )
    .expect("stage deleted line");

    let blob = repo.git(&["show", ":file.txt"]);
    assert_eq!(
        String::from_utf8_lossy(&blob.stdout),
        "one\ntwo\nfour\n",
        "only the selected line leaves the index"
    );
    let unstaged = repo.git(&["diff", "--", "file.txt"]);
    assert!(String::from_utf8_lossy(&unstaged.stdout).is_empty());
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
        &ApplyLineRequest {
            expected_new_no: Some(3),
            ..ApplyLineRequest::test("file.txt", true, 2, "add", "inserted")
        },
    )
    .expect("unstage added line");

    let blob = repo.git(&["show", ":file.txt"]);
    assert_eq!(
        String::from_utf8_lossy(&blob.stdout),
        "one\ntwo\nthree\nfour\n",
        "the unstaged line is the only one removed from the index"
    );
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
        &ApplyLineRequest {
            expected_new_no: Some(3),
            ..ApplyLineRequest::test("file.txt", false, 2, "add", "different")
        },
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
        &ApplyLineRequest {
            expected_new_no: Some(2),
            ..ApplyLineRequest::test("file.txt", false, 1, "add", "last")
        },
    )
    .expect("stage no-newline line");

    let blob = repo.git(&["show", ":file.txt"]);
    assert_eq!(blob.stdout, b"one\nlast");
}

/// A second pending change above the selected line must not move it.
///
/// The patch is applied to the index, but the line numbers in the displayed
/// diff are the worktree's. When an unstaged insertion sits earlier in the
/// file the two disagree, and a position-anchored fragment lands that many
/// lines away — silently, at exit 0.
#[test]
fn apply_line_stages_an_added_line_under_an_earlier_pending_insertion() {
    let repo = TempRepo::new("stage-line-add-offset");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(
        repo.0.join("file.txt"),
        "L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\n",
    )
    .unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    // "X" after L2 stays unstaged; only "Y" after L7 is staged.
    std::fs::write(
        repo.0.join("file.txt"),
        "L1\nL2\nX\nL3\nL4\nL5\nL6\nL7\nY\nL8\nL9\nL10\n",
    )
    .unwrap();

    apply_line(
        repo.path(),
        &ApplyLineRequest {
            expected_new_no: Some(9),
            ..ApplyLineRequest::test("file.txt", false, 8, "add", "Y")
        },
    )
    .expect("stage added line");

    let blob = repo.git(&["show", ":file.txt"]);
    assert_eq!(
        String::from_utf8_lossy(&blob.stdout),
        "L1\nL2\nL3\nL4\nL5\nL6\nL7\nY\nL8\nL9\nL10\n",
        "Y belongs directly after L7"
    );
}

/// The same defect on a deletion, where a duplicate of the deleted line sits
/// where the misplaced anchor lands: git matches it and removes the wrong one.
#[test]
fn apply_line_stages_the_selected_deletion_not_a_duplicate_below_it() {
    let repo = TempRepo::new("stage-line-del-duplicate");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), "a\nb\nc\nd\n}\ne\n}\ng\nh\ni\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    // Three unstaged insertions at the top, plus the deletion of the FIRST "}".
    std::fs::write(
        repo.0.join("file.txt"),
        "A\nB\nC\na\nb\nc\nd\ne\n}\ng\nh\ni\n",
    )
    .unwrap();

    apply_line(
        repo.path(),
        &ApplyLineRequest {
            expected_old_no: Some(5),
            ..ApplyLineRequest::test("file.txt", false, 7, "del", "}")
        },
    )
    .expect("stage deleted line");

    let blob = repo.git(&["show", ":file.txt"]);
    assert_eq!(
        String::from_utf8_lossy(&blob.stdout),
        "a\nb\nc\nd\ne\n}\ng\nh\ni\n",
        "the selected closing brace is the first one"
    );
}

/// Unstaging resolves against the index too, so the same anchor defect
/// reinserts a restored line next to the wrong neighbour.
#[test]
fn apply_line_unstages_the_selected_deletion_in_place() {
    let repo = TempRepo::new("unstage-line-del-offset");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), "a\nb\nc\nd\ne\nf\ng\nh\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    // Both deletions are staged; only "f" is put back.
    std::fs::write(repo.0.join("file.txt"), "a\nc\nd\ne\ng\nh\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);

    apply_line(
        repo.path(),
        &ApplyLineRequest {
            expected_old_no: Some(6),
            ..ApplyLineRequest::test("file.txt", true, 5, "del", "f")
        },
    )
    .expect("unstage deleted line");

    let blob = repo.git(&["show", ":file.txt"]);
    assert_eq!(
        String::from_utf8_lossy(&blob.stdout),
        "a\nc\nd\ne\nf\ng\nh\n",
        "f belongs back between e and g"
    );
}

/// The fourth direction/kind combination, so the fix is covered on all four.
#[test]
fn apply_line_unstages_the_selected_addition_in_place() {
    let repo = TempRepo::new("unstage-line-add-offset");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), "a\nb\nc\nd\ne\nf\ng\nh\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    // Both insertions are staged; only "Y" is taken back out.
    std::fs::write(repo.0.join("file.txt"), "a\nb\nX\nc\nd\ne\nf\nY\ng\nh\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);

    apply_line(
        repo.path(),
        &ApplyLineRequest {
            expected_new_no: Some(8),
            ..ApplyLineRequest::test("file.txt", true, 7, "add", "Y")
        },
    )
    .expect("unstage added line");

    let blob = repo.git(&["show", ":file.txt"]);
    assert_eq!(
        String::from_utf8_lossy(&blob.stdout),
        "a\nb\nX\nc\nd\ne\nf\ng\nh\n",
        "only Y leaves the index"
    );
}

/// `run_git` trims its output, and the diff's last line is the one being
/// staged. For a CRLF file that trim removes the CR, so the staged blob
/// silently loses it — at exit 0, with nothing to show the user.
#[test]
fn apply_hunk_keeps_carriage_returns_when_staging_the_last_line() {
    let repo = TempRepo::new("stage-hunk-crlf");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "core.autocrlf", "false"]);
    std::fs::write(repo.0.join("file.txt"), b"a\r\nb\r\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join("file.txt"), b"a\r\nb\r\nc\r\n").unwrap();

    let diff = repo.git(&["diff", "--", "file.txt"]);
    let body = String::from_utf8_lossy(&diff.stdout);
    let (header, rest) = body
        .split_once('\n')
        .map(|_| {
            let mut lines = body.lines().skip_while(|l| !l.starts_with("@@ "));
            let header = lines.next().unwrap_or_default().to_string();
            let rest = lines.collect::<Vec<_>>().join("\n");
            (header, rest)
        })
        .unwrap();

    apply_hunk(repo.path(), "file.txt", false, 0, &header, &rest).expect("stage the hunk");

    let blob = repo.git(&["show", ":file.txt"]);
    assert_eq!(
        blob.stdout, b"a\r\nb\r\nc\r\n",
        "every line keeps its carriage return"
    );
}

/// The patch is decoded with a lossy UTF-8 conversion, so a byte sequence that
/// is not valid UTF-8 on the side being written is staged as a replacement
/// character. The stale-content guard cannot catch it: the displayed diff goes
/// through the same conversion, so both sides agree.
#[test]
fn apply_hunk_keeps_bytes_that_are_not_valid_utf8() {
    let repo = TempRepo::new("stage-hunk-latin1");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    std::fs::write(repo.0.join("file.txt"), b"one\ntwo\n").unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    // 0xE9 is "é" in Latin-1 and not valid UTF-8, on the ADDED line.
    std::fs::write(repo.0.join("file.txt"), b"one\ntwo\ncaf\xe9\n").unwrap();

    let diff = repo.git(&["diff", "--", "file.txt"]);
    let body = String::from_utf8_lossy(&diff.stdout);
    let mut lines = body.lines().skip_while(|l| !l.starts_with("@@ "));
    let header = lines.next().unwrap_or_default().to_string();
    let rest = lines.collect::<Vec<_>>().join("\n");

    apply_hunk(repo.path(), "file.txt", false, 0, &header, &rest).expect("stage the hunk");

    let blob = repo.git(&["show", ":file.txt"]);
    assert_eq!(
        blob.stdout, b"one\ntwo\ncaf\xe9\n",
        "the original bytes are staged, not a replacement character"
    );
}

/// A clean filter that writes to stderr (the git-lfs class) has its warning
/// concatenated onto the diff, which lands inside the hunk body and makes the
/// stale-content comparison fail — permanently, for that repository.
#[test]
fn apply_hunk_ignores_filter_warnings_on_stderr() {
    let repo = TempRepo::new("stage-hunk-filter-warning");
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&[
        "config",
        "filter.noisy.clean",
        "sh -c 'echo warning: noisy filter >&2; cat'",
    ]);
    std::fs::write(repo.0.join(".gitattributes"), "*.txt filter=noisy\n").unwrap();
    std::fs::write(repo.0.join("file.txt"), b"one\ntwo\n").unwrap();
    repo.git_ok(&["add", "-A"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    std::fs::write(repo.0.join("file.txt"), b"one\ntwo\nthree\n").unwrap();

    let diff = repo.git(&["diff", "--", "file.txt"]);
    let body = String::from_utf8_lossy(&diff.stdout);
    let mut lines = body.lines().skip_while(|l| !l.starts_with("@@ "));
    let header = lines.next().unwrap_or_default().to_string();
    let rest = lines.collect::<Vec<_>>().join("\n");

    apply_hunk(repo.path(), "file.txt", false, 0, &header, &rest)
        .expect("a filter warning must not look like a changed hunk");

    let blob = repo.git(&["show", ":file.txt"]);
    assert_eq!(blob.stdout, b"one\ntwo\nthree\n");
}
