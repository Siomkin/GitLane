//! Patch fixtures shared by the parser tests.

pub(super) use super::super::parser::{
    parse_unified_diff, parse_unified_diff_with_limit, parse_unified_diff_with_limits,
    strip_patch_prefix,
};

pub(super) const SAMPLE: &str = "\
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

// Git C-quotes paths containing spaces or special bytes. The b-side path must
// be de-quoted, not stored as the raw `"a/..." "b/..."` header.
pub(super) const QUOTED: &str = "\
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

// Patch forms that carry no `@@` body: rename-only, copy, mode-only, and an
// empty new file. `gh pr diff` can emit any of them, so the per-file status
// classification is frozen here even though there are no hunks to count.
pub(super) const NO_BODY: &str = "\
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

// A single-line replacement where neither side ends in a newline. Git emits a
// `\ No newline at end of file` marker after each side; the parser must drop it
// rather than miscount it as a context line.
pub(super) const NO_EOL: &str = "\
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

// `gh pr diff --patch` is format-patch mailbox output, one message per commit.
// Every preamble hazard is represented: a folded `Subject:` continuation
// (leading space), a commit body with `-` bullets, indented lines, and a literal
// `rename from` line, the `---` separator, diffstat rows (leading space), and
// the dash-dash + git-version signature trailer (really `-- `; written `--`
// here so an invisible trailing space can't be stripped from the fixture). None
// of it may leak into the previous commit's last hunk or restyle its file
// status.
pub(super) const MAILBOX: &str = "\
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

// Byte-for-byte capture of `gh pr diff 85 --patch --color never` on this
// repository - the 2-commit PR the corruption was first reproduced on. The
// per-commit totals are asserted against git's own numbers (`git apply
// --numstat` / each message's diffstat), which any phantom preamble line would
// break.
pub(super) const PR_85: &str = include_str!("../../fixtures/pr_85_two_commits.patch");

// A malformed `@@` header still opens its (empty) hunk, but must not inherit
// the previous hunk's unconsumed counts — following lines would otherwise
// attach to the wrong hunk. The first hunk deliberately overstates its counts
// so leftovers exist when the bad header arrives.
pub(super) const MALFORMED_HEADER: &str = "\
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

// A mailbox message with a boundary but no `Subject:` header (hand-edited or
// truncated patch): the file still gets the commit oid, subject stays None,
// and body parsing is unaffected.
pub(super) const NO_SUBJECT: &str = "\
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
