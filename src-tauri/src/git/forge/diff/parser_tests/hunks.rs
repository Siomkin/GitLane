//! Hunk-body edge cases: the no-newline marker, a malformed header, and the
//! a/ b/ prefix stripping.

use super::support::*;

#[test]
fn skips_no_newline_marker_without_miscounting() {
    let files = parse_unified_diff(NO_EOL);
    assert_eq!(files.len(), 1);
    let f = &files[0];
    // One add, one del - the two marker lines are dropped, not counted.
    assert_eq!((f.add, f.del), (1, 1));
    let kinds: Vec<&str> = f.hunks[0].lines.iter().map(|l| l.kind.as_str()).collect();
    assert_eq!(kinds, ["del", "add"]);
}

#[test]
fn malformed_hunk_header_resets_leftover_counts() {
    let files = parse_unified_diff(MALFORMED_HEADER);
    assert_eq!(files.len(), 1);
    let f = &files[0];
    assert_eq!(f.hunks.len(), 2);
    assert_eq!(f.hunks[0].lines.len(), 3);
    // The garbage hunk owns no counts, so the stray lines are dropped.
    assert!(f.hunks[1].lines.is_empty());
    assert_eq!((f.add, f.del), (1, 1));
}

// The `[PATCH...]` marker strips only in the exact shape git emits; everything
// else passes through so a subject is never silently mangled.
#[test]
fn strip_patch_prefix_handles_marker_variants() {
    assert_eq!(strip_patch_prefix("[PATCH] title"), "title");
    assert_eq!(strip_patch_prefix("[PATCH 1/2] title"), "title");
    assert_eq!(strip_patch_prefix("[PATCH v2 3/7] title"), "title");
    // Marker with no title: strips to empty (a folded line may still follow).
    assert_eq!(strip_patch_prefix("[PATCH 1/2]"), "");
    // Not git's marker: lowercase, other tags, unclosed bracket, no bracket.
    assert_eq!(strip_patch_prefix("[patch] title"), "[patch] title");
    assert_eq!(strip_patch_prefix("[RFC] title"), "[RFC] title");
    assert_eq!(strip_patch_prefix("[PATCH title"), "[PATCH title");
    assert_eq!(strip_patch_prefix("plain title"), "plain title");
}

#[test]
fn global_line_budget_bounds_payload_but_keeps_complete_totals_and_files() {
    let patch = "\
diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
-old one
+new one
 context
diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -0,0 +1,2 @@
+later one
+later two
";

    let files = parse_unified_diff_with_limit(patch, 2);
    assert_eq!(files.len(), 2);
    assert_eq!((files[0].add, files[0].del), (1, 1));
    assert_eq!((files[1].add, files[1].del), (2, 0));
    assert_eq!(
        files
            .iter()
            .flat_map(|file| &file.hunks)
            .map(|hunk| hunk.lines.len())
            .sum::<usize>(),
        2
    );
    assert!(files[0].truncated);
    assert!(files[1].truncated);
}

#[test]
fn eof_before_hunk_counts_are_satisfied_marks_the_file_truncated() {
    let patch = "\
diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
-old
+new
 context
";

    let files = parse_unified_diff(patch);

    assert_eq!(files.len(), 1);
    assert!(files[0].truncated);
}

#[test]
fn per_file_budget_keeps_a_leading_large_file_from_starving_later_files() {
    let patch = "\
diff --git a/lock.txt b/lock.txt
--- a/lock.txt
+++ b/lock.txt
@@ -0,0 +1,3 @@
+one
+two
+three
diff --git a/src.rs b/src.rs
--- a/src.rs
+++ b/src.rs
@@ -0,0 +1,2 @@
+later one
+later two
";

    let files = parse_unified_diff_with_limits(patch, 4, 2);

    assert_eq!(files.len(), 2);
    assert_eq!(files[0].hunks[0].lines.len(), 2);
    assert!(files[0].truncated);
    assert_eq!(files[1].hunks[0].lines.len(), 2);
    assert!(!files[1].truncated);
}
