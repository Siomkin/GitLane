use super::parser::{
    parse_unified_diff, parse_unified_diff_with_limit, parse_unified_diff_with_limits,
    strip_patch_prefix,
};

const SAMPLE: &str = "\
diff --git a/src/foo.rs b/src/foo.rs
index 1111111..2222222 100644
--- a/src/foo.rs
+++ b/src/foo.rs
@@ -1,4 +1,5 @@
 fn main() {
-    let x = 1;
+    let x = 2;
+    let y = 3;
     println!(\"{x}\");
 }
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,1 @@
+hello
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 4444444..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..5555555
Binary files /dev/null and b/logo.png differ
";

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

// Git C-quotes paths containing spaces or special bytes. The b-side path must
// be de-quoted, not stored as the raw `"a/..." "b/..."` header.
const QUOTED: &str = "\
diff --git \"a/foo bar.txt\" \"b/foo bar.txt\"
index 1111111..2222222 100644
--- \"a/foo bar.txt\"
+++ \"b/foo bar.txt\"
@@ -1,1 +1,1 @@
-old
+new
diff --git \"a/caf\\303\\251.txt\" \"b/caf\\303\\251.txt\"
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ \"b/caf\\303\\251.txt\"
@@ -0,0 +1,1 @@
+hi
";

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

// Patch forms that carry no `@@` body: rename-only, copy, mode-only, and an
// empty new file. `gh pr diff` can emit any of them, so the per-file status
// classification is frozen here even though there are no hunks to count.
const NO_BODY: &str = "\
diff --git a/old/name.rs b/new/name.rs
similarity index 100%
rename from old/name.rs
rename to new/name.rs
diff --git a/src.txt b/copy.txt
similarity index 100%
copy from src.txt
copy to copy.txt
diff --git a/exec.sh b/exec.sh
old mode 100644
new mode 100755
diff --git a/empty.txt b/empty.txt
new file mode 100644
index 0000000..0000000
";

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

// A single-line replacement where neither side ends in a newline. Git emits a
// `\ No newline at end of file` marker after each side; the parser must drop it
// rather than miscount it as a context line.
const NO_EOL: &str = "\
diff --git a/no-eol.txt b/no-eol.txt
index 1111111..2222222 100644
--- a/no-eol.txt
+++ b/no-eol.txt
@@ -1,1 +1,1 @@
-old line
\\ No newline at end of file
+new line
\\ No newline at end of file
";

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

// `gh pr diff --patch` is format-patch mailbox output, one message per commit.
// Every preamble hazard is represented: a folded `Subject:` continuation
// (leading space), a commit body with `-` bullets, indented lines, and a literal
// `rename from` line, the `---` separator, diffstat rows (leading space), and
// the dash-dash + git-version signature trailer (really `-- `; written `--`
// here so an invisible trailing space can't be stripped from the fixture). None
// of it may leak into the previous commit's last hunk or restyle its file
// status.
const MAILBOX: &str = "\
From 1111111111111111111111111111111111111111 Mon Sep 17 00:00:00 2001
From: Dev <dev@example.com>
Date: Thu, 2 Jul 2026 19:24:55 +0300
Subject: [PATCH 1/2] feat: first commit with a subject long enough to fold
 onto a continuation line
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A body paragraph.

- a bullet that starts with a dash
+ a line that starts with a plus
  an indented line
rename from something in prose
---
 src/one.txt | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/src/one.txt b/src/one.txt
index 1111111..2222222 100644
--- a/src/one.txt
+++ b/src/one.txt
@@ -1,3 +1,3 @@
 first
-second
+SECOND
 third
--
2.39.5

From 2222222222222222222222222222222222222222 Mon Sep 17 00:00:00 2001
From: Dev <dev@example.com>
Date: Fri, 3 Jul 2026 11:02:55 +0300
Subject: [PATCH 2/2] fix: second commit
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Touches the same file again plus a new one.
---
 src/one.txt | 1 +
 src/two.txt | 1 +
 2 files changed, 2 insertions(+)
 create mode 100644 src/two.txt

diff --git a/src/one.txt b/src/one.txt
index 2222222..3333333 100644
--- a/src/one.txt
+++ b/src/one.txt
@@ -3 +3,2 @@ SECOND
 third
+fourth
diff --git a/src/two.txt b/src/two.txt
new file mode 100644
index 0000000..4444444
--- /dev/null
+++ b/src/two.txt
@@ -0,0 +1,1 @@
+hello
--
2.39.5
";

#[test]
fn format_patch_preamble_never_leaks_into_hunks() {
    let files = parse_unified_diff(MAILBOX);
    assert_eq!(files.len(), 3);

    // Commit 1's file: exactly the 4 body lines its @@ header promises - no
    // phantom lines from the trailer or commit 2's preamble, and no `R` status
    // from the prose `rename from` line.
    let one = &files[0];
    assert_eq!(one.path, "src/one.txt");
    assert_eq!(one.status, "M");
    assert_eq!((one.add, one.del), (1, 1));
    assert_eq!(one.hunks.len(), 1);
    let kinds: Vec<&str> = one.hunks[0].lines.iter().map(|l| l.kind.as_str()).collect();
    assert_eq!(kinds, ["ctx", "del", "add", "ctx"]);

    // Commit 2 re-touches the file (its own entry) with a count-less old side
    // (`-3` == `-3,1`) and adds a new file.
    let again = &files[1];
    assert_eq!(again.path, "src/one.txt");
    assert_eq!((again.add, again.del), (1, 0));
    let hunk = &again.hunks[0];
    let kinds: Vec<&str> = hunk.lines.iter().map(|l| l.kind.as_str()).collect();
    assert_eq!(kinds, ["ctx", "add"]);

    assert_eq!(files[2].path, "src/two.txt");
    assert_eq!(files[2].status, "A");
    assert_eq!((files[2].add, files[2].del), (1, 0));
}

#[test]
fn attributes_files_to_their_commit() {
    let files = parse_unified_diff(MAILBOX);

    // Commit 1: oid from the boundary line; the folded Subject is joined into
    // one line with the [PATCH 1/2] marker stripped.
    assert_eq!(
        files[0].commit_oid.as_deref(),
        Some("1111111111111111111111111111111111111111")
    );
    assert_eq!(
        files[0].commit_subject.as_deref(),
        Some("feat: first commit with a subject long enough to fold onto a continuation line")
    );

    // Commit 2 owns both of its files.
    for f in &files[1..] {
        assert_eq!(
            f.commit_oid.as_deref(),
            Some("2222222222222222222222222222222222222222")
        );
        assert_eq!(f.commit_subject.as_deref(), Some("fix: second commit"));
    }
}

#[test]
fn bare_unified_diff_carries_no_commit_attribution() {
    let files = parse_unified_diff(SAMPLE);
    assert!(files
        .iter()
        .all(|f| f.commit_oid.is_none() && f.commit_subject.is_none()));
}

// Byte-for-byte capture of `gh pr diff 85 --patch --color never` on this
// repository - the 2-commit PR the corruption was first reproduced on. The
// per-commit totals are asserted against git's own numbers (`git apply
// --numstat` / each message's diffstat), which any phantom preamble line would
// break.
const PR_85: &str = include_str!("../fixtures/pr_85_two_commits.patch");

#[test]
fn parses_real_two_commit_gh_patch() {
    let files = parse_unified_diff(PR_85);
    // 14 files in commit 1 + 3 in commit 2 (per-commit patches repeat a path
    // touched by both commits: src/git/status/tests.rs, preview.ts).
    assert_eq!(files.len(), 17);

    let (add1, del1) = files[..14]
        .iter()
        .fold((0, 0), |(a, d), f| (a + f.add, d + f.del));
    assert_eq!((add1, del1), (422, 30), "commit 1 diffstat totals");

    let (add2, del2) = files[14..]
        .iter()
        .fold((0, 0), |(a, d), f| (a + f.add, d + f.del));
    assert_eq!((add2, del2), (63, 3), "commit 2 diffstat totals");

    // The last file of commit 1 sits right against commit 2's preamble - the
    // exact spot the old parser appended phantom lines to.
    let paths = &files[13];
    assert_eq!(paths.path, "src/lib/paths.ts");
    assert_eq!((paths.add, paths.del), (5, 0));
    assert_eq!(paths.hunks.len(), 1);
    // @@ -16,3 +16,8 @@: 3 ctx + 5 add, nothing more.
    assert_eq!(paths.hunks[0].lines.len(), 8);

    // Commit 2 opens cleanly on its own first file.
    assert_eq!(files[14].path, "src-tauri/src/git/status/selection.rs");
    assert_eq!((files[14].add, files[14].del), (18, 1));

    // The five files created in commit 1 all classify as additions.
    let added = files.iter().filter(|f| f.status == "A").count();
    assert_eq!(added, 5);

    // Every file carries its commit's attribution; the folded real-world
    // Subject lines reassemble with the [PATCH n/2] marker stripped.
    let oid1 = "7a78caf48c32ceb917f821e21cff3df6f7138c0a";
    let oid2 = "00b13d71ceda75df5b0014d7a0b2b80a75284dd8";
    assert!(files[..14]
        .iter()
        .all(|f| f.commit_oid.as_deref() == Some(oid1)));
    assert!(files[14..]
        .iter()
        .all(|f| f.commit_oid.as_deref() == Some(oid2)));
    assert_eq!(
        files[0].commit_subject.as_deref(),
        Some("GL-100 feat(review): Code/Preview toggle renders markdown files")
    );
    assert_eq!(
        files[14].commit_subject.as_deref(),
        Some("GL-100 fix(review): selection diffs carry blob oids so markdown Preview loads")
    );
}

// A malformed `@@` header still opens its (empty) hunk, but must not inherit
// the previous hunk's unconsumed counts — following lines would otherwise
// attach to the wrong hunk. The first hunk deliberately overstates its counts
// so leftovers exist when the bad header arrives.
const MALFORMED_HEADER: &str = "\
diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,5 +1,5 @@
 one
-two
+TWO
@@ garbage @@
 stray context
+stray add
";

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

// A mailbox message with a boundary but no `Subject:` header (hand-edited or
// truncated patch): the file still gets the commit oid, subject stays None,
// and body parsing is unaffected.
const NO_SUBJECT: &str = "\
From 3333333333333333333333333333333333333333 Mon Sep 17 00:00:00 2001
From: Dev <dev@example.com>
Date: Thu, 2 Jul 2026 19:24:55 +0300

A body with no subject header above it.
---
 x.txt | 1 +
 1 file changed, 1 insertion(+)

diff --git a/x.txt b/x.txt
index 1111111..2222222 100644
--- a/x.txt
+++ b/x.txt
@@ -0,0 +1,1 @@
+hi
";

#[test]
fn boundary_without_subject_keeps_oid_and_no_subject() {
    let files = parse_unified_diff(NO_SUBJECT);
    assert_eq!(files.len(), 1);
    assert_eq!(
        files[0].commit_oid.as_deref(),
        Some("3333333333333333333333333333333333333333")
    );
    assert_eq!(files[0].commit_subject, None);
    assert_eq!((files[0].add, files[0].del), (1, 0));
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
