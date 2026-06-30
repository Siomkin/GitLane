//! PR patch fetching and the pure unified-diff parser.
//!
//! [`pr_diff`] shells out to `gh pr diff --patch --color never` (transport via
//! [`super::cli`]); everything below it — [`parse_unified_diff`] and its helpers
//! — is a pure function over the raw patch string, mirroring the `FileDiff`
//! shape libgit2 produces in `status.rs` so the frontend diff renderer is
//! shared. Parser helpers stay private; their fixtures live in this module.

use super::cli::run_gh;
use crate::git::types::{DiffHunk, DiffLine, FileDiff};

/// Full unified diff of a PR, parsed into per-file [`FileDiff`] so the existing
/// diff viewer renders it unchanged. `gh pr diff` emits a standard git patch.
pub fn pr_diff(workdir: &str, number: u64, token: Option<&str>) -> Result<Vec<FileDiff>, String> {
    let num = number.to_string();
    // `--patch` forces the unified-diff body (not a name-only summary) and
    // `--color never` strips ANSI so the parser sees a clean git patch.
    let raw = run_gh(
        workdir,
        &["pr", "diff", num.as_str(), "--patch", "--color", "never"],
        token,
    )?;
    Ok(parse_unified_diff(&raw))
}

/// Parse a multi-file git unified diff into [`FileDiff`]s, mirroring the shape
/// libgit2 produces in `status.rs` so the frontend painter is shared. Status is
/// the single-letter code the UI's `FileStatus` union expects (A/D/R/M).
fn parse_unified_diff(raw: &str) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    let mut old_no = 0u32;
    let mut new_no = 0u32;

    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            // `a/<path> b/<path>` — take the b-side path. Git C-quotes paths
            // with spaces/special chars (`"a/foo bar" "b/foo bar"`), so a naive
            // `split_once(" b/")` would swallow the whole header; `diff_git_b_path`
            // handles both the quoted and bare forms.
            let path = diff_git_b_path(rest);
            files.push(FileDiff {
                path,
                status: "M".to_string(),
                // GitHub patches arrive already bounded by gh's own diff limits;
                // byte sizes aren't carried in a unified patch, so the binary
                // size fields stay `None` (the card degrades to type + kind only).
                ..Default::default()
            });
            continue;
        }

        let Some(file) = files.last_mut() else {
            continue;
        };

        if line.starts_with("new file mode") {
            file.status = "A".to_string();
        } else if line.starts_with("deleted file mode") {
            file.status = "D".to_string();
        } else if line.starts_with("rename from") || line.starts_with("rename to") {
            file.status = "R".to_string();
        } else if line.starts_with("Binary files ") {
            file.binary = true;
        } else if line.starts_with("@@") {
            // @@ -oldStart,oldCount +newStart,newCount @@ [section]
            if let Some((os, ns)) = parse_hunk_header(line) {
                old_no = os;
                new_no = ns;
            }
            file.hunks.push(DiffHunk {
                header: line.to_string(),
                lines: Vec::new(),
            });
        } else if let Some(hunk) = file.hunks.last_mut() {
            // Body lines only count once we're inside a hunk. Skip file-header
            // noise (---/+++/index) which precedes the first @@.
            if line.starts_with("\\ No newline") {
                continue;
            }
            let (kind, content) = match line.as_bytes().first() {
                Some(b'+') => ("add", &line[1..]),
                Some(b'-') => ("del", &line[1..]),
                Some(b' ') => ("ctx", &line[1..]),
                _ => continue,
            };
            let (o, n) = match kind {
                "add" => {
                    file.add += 1;
                    let n = new_no;
                    new_no += 1;
                    (None, Some(n))
                }
                "del" => {
                    file.del += 1;
                    let o = old_no;
                    old_no += 1;
                    (Some(o), None)
                }
                _ => {
                    let (o, n) = (old_no, new_no);
                    old_no += 1;
                    new_no += 1;
                    (Some(o), Some(n))
                }
            };
            hunk.lines.push(DiffLine {
                kind: kind.to_string(),
                old_no: o,
                new_no: n,
                content: content.to_string(),
            });
        }
    }

    files
}

/// Extract the b-side path from a `diff --git ` header body (everything after
/// the `diff --git ` prefix). Handles both git forms:
/// - bare: `a/src/foo.rs b/src/foo.rs` → split on the ` b/`separator.
/// - C-quoted (path has spaces / special bytes): `"a/foo bar" "b/foo bar"` →
///   take the second quoted token, de-quote it, and drop the `b/` prefix.
fn diff_git_b_path(rest: &str) -> String {
    // A quoted b-side token is preceded by a space: `… "b/<escaped>"`. Find the
    // first ` "` and try to read a quoted token whose content starts with `b/`.
    if let Some(pos) = rest.find(" \"") {
        if let Some(token) = first_quoted_token(&rest[pos + 1..]) {
            let unquoted = c_unquote(&token);
            if let Some(stripped) = unquoted.strip_prefix("b/") {
                return stripped.to_string();
            }
        }
    }
    // Bare form (or an unrecognised quoted shape): best-effort split on ` b/`.
    rest.split_once(" b/")
        .map(|(_, b)| b.to_string())
        .unwrap_or_else(|| rest.to_string())
}

/// Read a double-quoted token starting at the leading `"` of `s`, returning its
/// inner contents (still escaped) up to the matching unescaped closing quote.
/// `None` if `s` doesn't start with `"` or the quote is never closed.
fn first_quoted_token(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    if bytes.first() != Some(&b'"') {
        return None;
    }
    let mut i = 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2, // skip the escaped byte (e.g. \" or \\)
            b'"' => return Some(s[1..i].to_string()),
            _ => i += 1,
        }
    }
    None
}

/// Decode a git C-quoted path token (the bytes between the surrounding quotes),
/// undoing the escapes `core.quotePath` emits: `\\`, `\"`, `\t`, `\n`, `\r`, and
/// octal `\NNN` byte escapes (which reassemble into UTF-8).
fn c_unquote(inner: &str) -> String {
    let bytes = inner.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' || i + 1 >= bytes.len() {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        match bytes[i + 1] {
            b'\\' => {
                out.push(b'\\');
                i += 2;
            }
            b'"' => {
                out.push(b'"');
                i += 2;
            }
            b't' => {
                out.push(b'\t');
                i += 2;
            }
            b'n' => {
                out.push(b'\n');
                i += 2;
            }
            b'r' => {
                out.push(b'\r');
                i += 2;
            }
            b'0'..=b'7' => {
                // Up to three octal digits → one raw byte.
                let mut val: u16 = 0;
                let mut k = 0;
                while k < 3
                    && bytes
                        .get(i + 1 + k)
                        .is_some_and(|b| (b'0'..=b'7').contains(b))
                {
                    val = val * 8 + u16::from(bytes[i + 1 + k] - b'0');
                    k += 1;
                }
                out.push(val as u8);
                i += 1 + k;
            }
            _ => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parse the start line numbers from an `@@ -a,b +c,d @@` hunk header.
fn parse_hunk_header(header: &str) -> Option<(u32, u32)> {
    let inner = header.strip_prefix("@@ ")?;
    let inner = inner.split(" @@").next()?;
    let mut parts = inner.split_whitespace();
    let old = parts.next()?.trim_start_matches('-');
    let new = parts.next()?.trim_start_matches('+');
    let old_start = old.split(',').next()?.parse().ok()?;
    let new_start = new.split(',').next()?.parse().ok()?;
    Some((old_start, new_start))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
diff --git a/src/foo.rs b/src/foo.rs
index 1111111..2222222 100644
--- a/src/foo.rs
+++ b/src/foo.rs
@@ -1,3 +1,4 @@
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

    // Git C-quotes paths containing spaces or special bytes. The b-side path
    // must be de-quoted, not stored as the raw `"a/…" "b/…"` header.
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

    #[test]
    fn diff_git_b_path_handles_both_forms() {
        assert_eq!(diff_git_b_path("a/src/foo.rs b/src/foo.rs"), "src/foo.rs");
        assert_eq!(diff_git_b_path("\"a/foo bar\" \"b/foo bar\""), "foo bar");
        // Rename to a different quoted name keeps the b-side.
        assert_eq!(
            diff_git_b_path("a/old.txt \"b/new name.txt\""),
            "new name.txt"
        );
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
    // `\ No newline at end of file` marker after each side; the parser must drop
    // it rather than miscount it as a context line.
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
        // One add, one del — the two marker lines are dropped, not counted.
        assert_eq!((f.add, f.del), (1, 1));
        let kinds: Vec<&str> = f.hunks[0].lines.iter().map(|l| l.kind.as_str()).collect();
        assert_eq!(kinds, ["del", "add"]);
    }
}
