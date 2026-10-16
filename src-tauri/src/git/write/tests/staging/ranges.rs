//! Line-range staging, unstaging and working-tree revert (`changes/patch-staging`).

use super::super::support::*;

fn line(kind: &str, old_no: Option<u32>, new_no: Option<u32>, content: &str) -> DiffLine {
    DiffLine {
        kind: kind.into(),
        old_no,
        new_no,
        content: content.into(),
    }
}

fn numbered(lines: std::ops::RangeInclusive<u32>, eol: &str) -> String {
    lines.map(|n| format!("l{n}{eol}")).collect()
}

/// A 20-line committed file with an unstaged insertion after line 1 and an
/// unstaged replacement of line 15 by three lines, far enough apart to be two hunks.
fn two_blocks(tag: &str, eol: &str) -> TempRepo {
    let repo = TempRepo::new(tag);
    repo.git_ok(&["init", "-q"]);
    repo.git_ok(&["config", "user.name", "GitLane Test"]);
    repo.git_ok(&["config", "user.email", "gitlane@example.test"]);
    repo.git_ok(&["config", "core.autocrlf", "false"]);
    std::fs::write(repo.0.join("file.txt"), numbered(1..=20, eol)).unwrap();
    repo.git_ok(&["add", "file.txt"]);
    repo.git_ok(&["commit", "-q", "-m", "initial"]);
    let edited = format!(
        "l1{eol}top{eol}{}a{eol}b{eol}c{eol}{}",
        numbered(2..=14, eol),
        numbered(16..=20, eol)
    );
    std::fs::write(repo.0.join("file.txt"), edited).unwrap();
    repo
}

/// The replacement block in hunk 1 (after ctx l12..l14). The numbers are the
/// same in the unstaged diff (index = HEAD) and, after `git add`, the staged one.
fn replacement() -> DiffLineRange {
    DiffLineRange {
        hunk_index: 1,
        line_start: 3,
        expected: vec![
            line("del", Some(15), None, "l15"),
            line("add", None, Some(16), "a"),
            line("add", None, Some(17), "b"),
            line("add", None, Some(18), "c"),
        ],
    }
}

fn request(staged: bool, ranges: Vec<DiffLineRange>) -> ApplyLineRangeRequest {
    ApplyLineRangeRequest {
        file: "file.txt".into(),
        staged,
        ranges,
    }
}

fn index_blob(repo: &TempRepo) -> String {
    String::from_utf8_lossy(&repo.git(&["show", ":file.txt"]).stdout).into_owned()
}

#[test]
fn stages_a_block_below_another_unstaged_change() {
    let repo = two_blocks("range-stage", "\n");
    apply_line_range(repo.path(), &request(false, vec![replacement()])).expect("stage");

    assert_eq!(
        index_blob(&repo),
        format!(
            "{}a\nb\nc\n{}",
            numbered(1..=14, "\n"),
            numbered(16..=20, "\n")
        ),
        "the three lines replace l15 and the insertion stays out"
    );
    let unstaged =
        String::from_utf8_lossy(&repo.git(&["diff", "--", "file.txt"]).stdout).into_owned();
    assert!(unstaged.contains("+top"), "the insertion is still unstaged");
    assert!(
        !unstaged.contains("+a"),
        "nothing of the block is left unstaged"
    );
}

#[test]
fn unstages_a_removed_and_added_block() {
    let repo = two_blocks("range-unstage", "\n");
    repo.git_ok(&["add", "file.txt"]);
    apply_line_range(repo.path(), &request(true, vec![replacement()])).expect("unstage");

    assert_eq!(
        index_blob(&repo),
        format!("l1\ntop\n{}", numbered(2..=20, "\n")),
        "only the replacement left the index"
    );
}

#[test]
fn one_stale_line_refuses_the_whole_range() {
    let repo = two_blocks("range-stale", "\n");
    let mut range = replacement();
    range.expected[3].content = "not c".into();

    let error = apply_line_range(repo.path(), &request(false, vec![range])).unwrap_err();
    assert!(error.contains("Refresh and try again."), "{error}");
    assert!(
        repo.git(&["diff", "--cached"]).stdout.is_empty(),
        "index untouched"
    );
}

#[test]
fn reverts_the_lower_of_two_unstaged_blocks() {
    let repo = two_blocks("range-revert", "\n");
    revert_line_range(repo.path(), &request(false, vec![replacement()])).expect("revert");

    assert_eq!(
        std::fs::read_to_string(repo.0.join("file.txt")).unwrap(),
        format!("l1\ntop\n{}", numbered(2..=20, "\n")),
        "l15 is back and the insertion stays"
    );
    assert!(
        repo.git(&["diff", "--cached"]).stdout.is_empty(),
        "index untouched"
    );
}

#[test]
fn revert_keeps_crlf_line_endings() {
    let repo = two_blocks("range-revert-crlf", "\r\n");
    revert_line_range(repo.path(), &request(false, vec![replacement()])).expect("revert");

    assert_eq!(
        std::fs::read(repo.0.join("file.txt")).unwrap(),
        format!("l1\r\ntop\r\n{}", numbered(2..=20, "\r\n")).into_bytes(),
        "every remaining line still ends with CR LF"
    );
}

#[test]
fn revert_refuses_a_range_next_to_staged_content() {
    let repo = two_blocks("range-revert-staged", "\n");
    // Stage the replacement, then edit one of its lines again in the working tree.
    repo.git_ok(&["add", "file.txt"]);
    let edited = format!(
        "l1\ntop\n{}a\nB\nc\n{}",
        numbered(2..=14, "\n"),
        numbered(16..=20, "\n")
    );
    std::fs::write(repo.0.join("file.txt"), &edited).unwrap();
    let range = DiffLineRange {
        hunk_index: 0,
        line_start: 3,
        expected: vec![
            line("del", Some(17), None, "b"),
            line("add", None, Some(17), "B"),
        ],
    };

    let error = revert_line_range(repo.path(), &request(false, vec![range])).unwrap_err();
    assert!(error.contains("staged"), "{error}");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("file.txt")).unwrap(),
        edited
    );
}

#[test]
fn revert_refuses_when_the_file_changed_after_the_diff() {
    let repo = two_blocks("range-revert-raced", "\n");
    let request = request(false, vec![replacement()]);
    let raced = format!(
        "l1\ntop\n{}a\nb\nz\n{}",
        numbered(2..=14, "\n"),
        numbered(16..=20, "\n")
    );
    std::fs::write(repo.0.join("file.txt"), &raced).unwrap();

    let error = revert_line_range(repo.path(), &request).unwrap_err();
    assert!(error.contains("Refresh and try again."), "{error}");
    assert_eq!(
        std::fs::read_to_string(repo.0.join("file.txt")).unwrap(),
        raced
    );
}
