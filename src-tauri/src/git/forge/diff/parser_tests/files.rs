//! Per-file parsing: status and counts, per-side line numbers, quoted paths,
//! and the rename/copy/mode entries that carry no body.

use super::support::*;

#[test]
fn parses_status_paths_and_counts() {
    let files = parse_unified_diff(SAMPLE);
    assert_eq!(files.len(), 4);

    let foo = &files[0];
    assert_eq!(foo.path, "src/foo.rs");
    assert_eq!(foo.status, "M");
    assert_eq!((foo.add, foo.del), (2, 1));
    assert!(!foo.binary);

    assert_eq!(files[1].path, "new.txt");
    assert_eq!(files[1].status, "A");
    assert_eq!(files[2].status, "D");

    let png = &files[3];
    assert_eq!(png.status, "A");
    assert!(png.binary);
    assert!(png.hunks.is_empty());
}

#[test]
fn assigns_line_numbers_per_side() {
    let files = parse_unified_diff(SAMPLE);
    let hunk = &files[0].hunks[0];
    // ctx, del, add, add, ctx, ctx
    let kinds: Vec<&str> = hunk.lines.iter().map(|l| l.kind.as_str()).collect();
    assert_eq!(kinds, ["ctx", "del", "add", "add", "ctx", "ctx"]);

    // The deleted "let x = 1;" sits on the old side only.
    let del = &hunk.lines[1];
    assert_eq!(del.old_no, Some(2));
    assert_eq!(del.new_no, None);

    // The first added line takes new-line 2 and has no old number.
    let add = &hunk.lines[2];
    assert_eq!(add.old_no, None);
    assert_eq!(add.new_no, Some(2));
}

#[test]
fn parses_quoted_paths_with_spaces_and_escapes() {
    let files = parse_unified_diff(QUOTED);
    assert_eq!(files.len(), 2);

    // A space in the path: the quotes are stripped and the b/ prefix dropped.
    assert_eq!(files[0].path, "foo bar.txt");
    assert_eq!(files[0].status, "M");
    assert_eq!((files[0].add, files[0].del), (1, 1));

    // Octal `\303\251` is UTF-8 for "é".
    assert_eq!(files[1].path, "café.txt");
    assert_eq!(files[1].status, "A");
}

#[test]
fn classifies_rename_copy_mode_and_empty_without_a_body() {
    let files = parse_unified_diff(NO_BODY);
    assert_eq!(files.len(), 4);

    // Rename-only: b-side path, status R, no hunks.
    assert_eq!(files[0].path, "new/name.rs");
    assert_eq!(files[0].status, "R");
    assert!(files[0].hunks.is_empty());

    // Copy: `FileStatus` has no "C" code, so a copied file reads as a
    // modification of its destination path (the parser ignores copy from/to).
    assert_eq!(files[1].path, "copy.txt");
    assert_eq!(files[1].status, "M");
    assert!(files[1].hunks.is_empty());

    // Mode-only change emits "new mode" (not "new file mode"), so it stays M
    // with no additions/deletions.
    assert_eq!(files[2].path, "exec.sh");
    assert_eq!(files[2].status, "M");
    assert_eq!((files[2].add, files[2].del), (0, 0));

    // Empty new file: status A, no body.
    assert_eq!(files[3].path, "empty.txt");
    assert_eq!(files[3].status, "A");
    assert!(files[3].hunks.is_empty());
}
