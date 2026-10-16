//! Per-difference inclusion for the commit review Include view, and the round
//! trip from the read's targets through the range writes.

use super::super::diff::DIFF_LINE_LIMIT;
use super::super::working_file_differences;
use super::support::*;
use crate::git::types::{ApplyLineRangeRequest, Inclusion};
use crate::git::write::patch_staging::{apply_line_range, revert_line_range};

fn lines(spec: &[&str]) -> String {
    spec.iter().map(|l| format!("{l}\n")).collect()
}

/// `l1..l20` committed as `file.txt`, with `edits` applied as `(line, text)`.
fn file_with(edits: &[(usize, &str)]) -> String {
    let mut out: Vec<String> = (1..=20).map(|n| format!("l{n}")).collect();
    for (line, text) in edits {
        out[line - 1] = (*text).to_string();
    }
    lines(&out.iter().map(String::as_str).collect::<Vec<_>>())
}

fn repo(tag: &str) -> PathBuf {
    let dir = git_init(tag);
    fs::write(dir.join("file.txt"), file_with(&[])).unwrap();
    git_ok(&dir, &["add", "file.txt"]);
    git_ok(&dir, &["commit", "-q", "-m", "initial"]);
    dir
}

fn inclusions(dir: &Path) -> Vec<Inclusion> {
    working_file_differences(dir.to_str().unwrap(), "file.txt", false)
        .unwrap()
        .differences
        .iter()
        .map(|d| d.inclusion)
        .collect()
}

#[test]
fn two_unstaged_edits_are_two_excluded_differences() {
    let dir = repo("differences-two-unstaged");
    fs::write(
        dir.join("file.txt"),
        file_with(&[(2, "two"), (18, "eighteen")]),
    )
    .unwrap();

    let result = working_file_differences(dir.to_str().unwrap(), "file.txt", false).unwrap();
    assert_eq!(result.diff.hunks.len(), 2);
    assert_eq!(
        result
            .differences
            .iter()
            .map(|d| d.inclusion)
            .collect::<Vec<_>>(),
        vec![Inclusion::Excluded, Inclusion::Excluded]
    );
    let first = &result.differences[0];
    assert_eq!(first.stage.len(), 1);
    assert!(first.unstage.is_empty());
    assert_eq!(
        first.stage[0]
            .expected
            .iter()
            .map(|l| (l.kind.as_str(), l.content.as_str()))
            .collect::<Vec<_>>(),
        vec![("del", "l2"), ("add", "two")]
    );
}

#[test]
fn a_staged_and_an_unstaged_edit_split_into_included_and_excluded() {
    let dir = repo("differences-staged-unstaged");
    fs::write(dir.join("file.txt"), file_with(&[(2, "two")])).unwrap();
    git_ok(&dir, &["add", "file.txt"]);
    fs::write(
        dir.join("file.txt"),
        file_with(&[(2, "two"), (18, "eighteen")]),
    )
    .unwrap();

    let result = working_file_differences(dir.to_str().unwrap(), "file.txt", false).unwrap();
    assert_eq!(
        result
            .differences
            .iter()
            .map(|d| d.inclusion)
            .collect::<Vec<_>>(),
        vec![Inclusion::Included, Inclusion::Excluded]
    );
    assert_eq!(result.differences[0].unstage.len(), 1);
    assert!(result.differences[0].stage.is_empty());
}

#[test]
fn a_partly_staged_block_is_partial() {
    let dir = repo("differences-partial");
    fs::write(dir.join("file.txt"), file_with(&[(10, "a")])).unwrap();
    git_ok(&dir, &["add", "file.txt"]);
    fs::write(dir.join("file.txt"), file_with(&[(10, "a\nb")])).unwrap();

    assert_eq!(inclusions(&dir), vec![Inclusion::Partial]);
}

#[test]
fn a_staged_change_reverted_in_the_worktree_shows_no_difference() {
    // HEAD and the working tree agree; only the index differs. Nothing can be
    // rendered against HEAD, and no difference may claim the staged block.
    let dir = repo("differences-hidden-staged");
    fs::write(dir.join("file.txt"), file_with(&[(10, "staged")])).unwrap();
    git_ok(&dir, &["add", "file.txt"]);
    fs::write(dir.join("file.txt"), file_with(&[])).unwrap();

    let result = working_file_differences(dir.to_str().unwrap(), "file.txt", false).unwrap();
    assert!(result.differences.is_empty());
    assert!(result.diff.hunks.is_empty());
}

#[test]
fn untracked_and_binary_files_are_whole_file_only() {
    let dir = repo("differences-whole-file");
    fs::write(dir.join("new.txt"), "fresh\n").unwrap();
    let untracked = working_file_differences(dir.to_str().unwrap(), "new.txt", false).unwrap();
    assert!(untracked.differences.is_empty());
    assert!(
        !untracked.diff.hunks.is_empty(),
        "the content still renders"
    );

    fs::write(dir.join("blob.bin"), [0u8, 1, 2, 0, 3]).unwrap();
    git_ok(&dir, &["add", "blob.bin"]);
    git_ok(&dir, &["commit", "-q", "-m", "blob"]);
    fs::write(dir.join("blob.bin"), [0u8, 9, 9, 0, 3]).unwrap();
    let binary = working_file_differences(dir.to_str().unwrap(), "blob.bin", false).unwrap();
    assert!(binary.differences.is_empty());
}

#[test]
fn including_and_excluding_through_the_targets_round_trips() {
    let dir = repo("differences-round-trip");
    let path = dir.to_str().unwrap();
    fs::write(
        dir.join("file.txt"),
        file_with(&[(2, "two"), (10, "ten"), (18, "eighteen")]),
    )
    .unwrap();

    let second = working_file_differences(path, "file.txt", false)
        .unwrap()
        .differences[1]
        .clone();
    let include = ApplyLineRangeRequest {
        file: "file.txt".into(),
        staged: false,
        ranges: second.stage,
    };
    apply_line_range(path, &include).expect("include the second difference");
    assert_eq!(
        inclusions(&dir),
        vec![
            Inclusion::Excluded,
            Inclusion::Included,
            Inclusion::Excluded
        ]
    );
    assert_eq!(
        git_stdout(&dir, &["show", ":file.txt"]),
        file_with(&[(10, "ten")]).trim_end()
    );

    let second = working_file_differences(path, "file.txt", false)
        .unwrap()
        .differences[1]
        .clone();
    let exclude = ApplyLineRangeRequest {
        file: "file.txt".into(),
        staged: true,
        ranges: second.unstage,
    };
    apply_line_range(path, &exclude).expect("exclude it again");
    assert_eq!(inclusions(&dir), vec![Inclusion::Excluded; 3]);

    let third = working_file_differences(path, "file.txt", false)
        .unwrap()
        .differences[2]
        .clone();
    let revert = ApplyLineRangeRequest {
        file: "file.txt".into(),
        staged: false,
        ranges: third.stage,
    };
    revert_line_range(path, &revert).expect("revert the third difference");
    assert_eq!(
        fs::read_to_string(dir.join("file.txt")).unwrap(),
        file_with(&[(2, "two"), (10, "ten")])
    );
}

#[test]
fn whole_file_mode_shows_every_line_with_the_same_differences() {
    let dir = repo("differences-whole-file-mode");
    let path = dir.to_str().unwrap();
    fs::write(
        dir.join("file.txt"),
        file_with(&[(2, "two"), (10, "ten"), (18, "eighteen")]),
    )
    .unwrap();

    let whole = working_file_differences(path, "file.txt", true).unwrap();
    assert!(whole.whole_file);
    assert_eq!(whole.diff.hunks.len(), 1, "one hunk spans the file");
    let ctx = whole.diff.hunks[0]
        .lines
        .iter()
        .filter(|l| l.kind == "ctx")
        .count();
    assert_eq!(ctx, 17, "every unchanged line is shown");
    let hunked = working_file_differences(path, "file.txt", false).unwrap();
    assert!(!hunked.whole_file);
    assert_eq!(
        whole
            .differences
            .iter()
            .map(|d| (d.inclusion, d.stage.clone()))
            .collect::<Vec<_>>(),
        hunked
            .differences
            .iter()
            .map(|d| (d.inclusion, d.stage.clone()))
            .collect::<Vec<_>>(),
        "the same differences with the same write targets"
    );

    let include = ApplyLineRangeRequest {
        file: "file.txt".into(),
        staged: false,
        ranges: whole.differences[1].stage.clone(),
    };
    apply_line_range(path, &include).expect("include from whole-file mode");
    assert_eq!(
        git_stdout(&dir, &["show", ":file.txt"]),
        file_with(&[(10, "ten")]).trim_end()
    );
}

#[test]
fn whole_file_mode_falls_back_to_hunks_for_a_long_file() {
    let dir = git_init("differences-whole-file-long");
    let long: String = (0..DIFF_LINE_LIMIT + 10)
        .map(|n| format!("l{n}\n"))
        .collect();
    fs::write(dir.join("big.txt"), &long).unwrap();
    git_ok(&dir, &["add", "big.txt"]);
    git_ok(&dir, &["commit", "-q", "-m", "big"]);
    fs::write(dir.join("big.txt"), long.replacen("l5\n", "five\n", 1)).unwrap();

    let result = working_file_differences(dir.to_str().unwrap(), "big.txt", true).unwrap();
    assert!(!result.whole_file, "too long to show whole");
    assert!(!result.diff.truncated);
    assert_eq!(
        result.differences.len(),
        1,
        "the difference is still addressable"
    );
}
