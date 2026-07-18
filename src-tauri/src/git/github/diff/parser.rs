//! Pure parser for bare unified diffs and `gh pr diff --patch` mailbox output.

use super::path::diff_git_b_path;
use crate::git::types::{DiffHunk, DiffLine, FileDiff};

/// Maximum number of text-diff body lines retained across one PR/MR patch.
/// The parser still scans the complete provider response after this budget is
/// exhausted so file metadata and add/delete totals remain truthful; only the
/// serialized hunk bodies are bounded.
const MAX_PR_DIFF_LINES: usize = 20_000;

/// Parse a git patch into [`FileDiff`]s, mirroring the shape libgit2 produces
/// in `status.rs` so the frontend painter is shared. Status is the
/// single-letter code the UI's `FileStatus` union expects (A/D/R/M).
///
/// Two guards keep per-commit preamble out of the diff data:
/// - a commit boundary (`From <sha> Mon Sep 17 00:00:00 2001`) drops the
///   parser back into preamble state until the next `diff --git`, so commit
///   bodies and diffstats can't mutate the previous commit's file;
/// - hunk bodies are bounded by their `@@` header counts, so trailing lines
///   (format-patch's `-- ` signature, stray text) never extend a hunk.
pub(in crate::git::github) fn parse_unified_diff(raw: &str) -> Vec<FileDiff> {
    parse_unified_diff_with_limit(raw, MAX_PR_DIFF_LINES)
}

pub(super) fn parse_unified_diff_with_limit(raw: &str, line_limit: usize) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    let mut stored_lines = 0usize;
    let mut old_no = 0u32;
    let mut new_no = 0u32;
    // Body lines the current hunk still expects on each side, per its `@@`
    // header. Both at zero = not inside a hunk.
    let mut old_left = 0u32;
    let mut new_left = 0u32;
    // True between a mailbox commit boundary and its first `diff --git`: mail
    // headers, the commit message, the `---` separator, and the diffstat.
    let mut in_preamble = false;
    // Attribution for the mailbox message currently being read: the boundary
    // line's oid and the `Subject:` header (folded continuations joined,
    // `[PATCH n/m]` stripped). Every file until the next boundary carries it.
    let mut commit_oid: Option<String> = None;
    let mut commit_subject: Option<String> = None;
    // True while the next preamble line may still be a folded (whitespace-led)
    // continuation of the `Subject:` header.
    let mut folding_subject = false;

    for line in raw.lines() {
        if let Some(sha) = commit_boundary_sha(line) {
            in_preamble = true;
            old_left = 0;
            new_left = 0;
            commit_oid = Some(sha.to_string());
            commit_subject = None;
            folding_subject = false;
            continue;
        }
        if let Some(rest) = line.strip_prefix("diff --git ") {
            // `a/<path> b/<path>` - take the b-side path. Git C-quotes paths
            // with spaces/special chars (`"a/foo bar" "b/foo bar"`), so a
            // naive `split_once(" b/")` would swallow the whole header.
            let path = diff_git_b_path(rest);
            in_preamble = false;
            old_left = 0;
            new_left = 0;
            files.push(FileDiff {
                path,
                status: "M".to_string(),
                commit_oid: commit_oid.clone(),
                commit_subject: commit_subject.clone(),
                // Unified patches don't carry byte sizes, so the binary size
                // fields stay `None`.
                ..Default::default()
            });
            continue;
        }
        if in_preamble {
            if let Some(rest) = line.strip_prefix("Subject: ") {
                commit_subject = Some(strip_patch_prefix(rest).to_string());
                folding_subject = true;
            } else if folding_subject && line.starts_with([' ', '\t']) {
                if let Some(subject) = commit_subject.as_mut() {
                    subject.push(' ');
                    subject.push_str(line.trim());
                }
            } else {
                // Any other header, the blank line, or body text ends folding.
                folding_subject = false;
            }
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
            if let Some((os, oc, ns, nc)) = parse_hunk_header(line) {
                old_no = os;
                new_no = ns;
                old_left = oc;
                new_left = nc;
            } else {
                // A malformed header still opens a (empty) hunk, but must not
                // inherit the previous hunk's leftover counts — following
                // lines would attach to the wrong hunk.
                old_left = 0;
                new_left = 0;
            }
            if stored_lines < line_limit {
                file.hunks.push(DiffHunk {
                    header: line.to_string(),
                    lines: Vec::new(),
                });
            } else {
                file.truncated = true;
            }
        } else if old_left > 0 || new_left > 0 {
            // Body lines only count while the current hunk still owes lines.
            // (`\ No newline` markers don't consume a count on either side.)
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
                    new_left = new_left.saturating_sub(1);
                    let n = new_no;
                    new_no += 1;
                    (None, Some(n))
                }
                "del" => {
                    file.del += 1;
                    old_left = old_left.saturating_sub(1);
                    let o = old_no;
                    old_no += 1;
                    (Some(o), None)
                }
                _ => {
                    old_left = old_left.saturating_sub(1);
                    new_left = new_left.saturating_sub(1);
                    let (o, n) = (old_no, new_no);
                    old_no += 1;
                    new_no += 1;
                    (Some(o), Some(n))
                }
            };
            if stored_lines < line_limit {
                if let Some(hunk) = file.hunks.last_mut() {
                    hunk.lines.push(DiffLine {
                        kind: kind.to_string(),
                        old_no: o,
                        new_no: n,
                        content: content.to_string(),
                    });
                    stored_lines += 1;
                }
            } else {
                file.truncated = true;
            }
        }
    }

    files
}

/// The commit oid of a format-patch mailbox boundary line: `From <40-hex-sha>
/// Mon Sep 17 00:00:00 2001` - git's fixed magic date, so a commit-message
/// line that merely starts with `From ` can't false-positive. `None` when the
/// line is not a boundary.
fn commit_boundary_sha(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("From ")?;
    let (sha, tail) = (rest.get(..40)?, rest.get(40..)?);
    (sha.bytes().all(|b| b.is_ascii_hexdigit()) && tail.starts_with(" Mon Sep 17 00:00:00 2001"))
        .then_some(sha)
}

/// Strip the `[PATCH...]` marker format-patch prefixes subjects with
/// (`[PATCH]`, `[PATCH 1/2]`, `[PATCH v2 3/7]`), leaving the commit subject.
/// Anything else — no bracket, an unclosed bracket, a non-PATCH tag — passes
/// through untouched (git emits the marker uppercase).
pub(super) fn strip_patch_prefix(subject: &str) -> &str {
    let Some(rest) = subject.strip_prefix('[') else {
        return subject;
    };
    match rest.split_once(']') {
        Some((tag, tail)) if tag.starts_with("PATCH") => tail.trim_start(),
        _ => subject,
    }
}

/// Parse an `@@ -a[,b] +c[,d] @@` hunk header into
/// `(old_start, old_count, new_start, new_count)`. A side without an explicit
/// count is git's one-line shorthand (`-3` == `-3,1`).
fn parse_hunk_header(header: &str) -> Option<(u32, u32, u32, u32)> {
    let inner = header.strip_prefix("@@ ")?;
    let inner = inner.split(" @@").next()?;
    let mut parts = inner.split_whitespace();
    let (old_start, old_count) = parse_hunk_range(parts.next()?.strip_prefix('-')?)?;
    let (new_start, new_count) = parse_hunk_range(parts.next()?.strip_prefix('+')?)?;
    Some((old_start, old_count, new_start, new_count))
}

/// Parse one side of a hunk header (`start[,count]`), defaulting count to 1.
fn parse_hunk_range(s: &str) -> Option<(u32, u32)> {
    match s.split_once(',') {
        Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
        None => Some((s.parse().ok()?, 1)),
    }
}
