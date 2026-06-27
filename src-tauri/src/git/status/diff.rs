//! Shared libgit2 diff-to-DTO conversion helpers.

use git2::{Delta, Diff, Patch};

use crate::git::types::{DiffHunk, DiffLine, FileChange, FileDiff};

/// Map a `git2` delta status to the one-letter code the frontend expects.
fn status_letter(status: Delta) -> &'static str {
    match status {
        Delta::Added => "A",
        Delta::Deleted => "D",
        Delta::Modified => "M",
        Delta::Renamed => "R",
        Delta::Copied => "C",
        Delta::Typechange => "T",
        Delta::Untracked => "U",
        _ => "M",
    }
}

/// Map a single `DiffLine` origin char to its `kind` plus old/new line numbers.
fn line_for(line: &git2::DiffLine) -> DiffLine {
    let content = {
        let raw = String::from_utf8_lossy(line.content());
        raw.trim_end_matches('\n')
            .trim_end_matches('\r')
            .to_string()
    };
    match line.origin() {
        '+' => DiffLine {
            kind: "add".to_string(),
            old_no: None,
            new_no: line.new_lineno(),
            content,
        },
        '-' => DiffLine {
            kind: "del".to_string(),
            old_no: line.old_lineno(),
            new_no: None,
            content,
        },
        _ => DiffLine {
            kind: "ctx".to_string(),
            old_no: line.old_lineno(),
            new_no: line.new_lineno(),
            content,
        },
    }
}

/// Per-file cap on rendered diff lines. A single pathological file (a minified
/// bundle, a generated lockfile, a vendored blob) can hold hundreds of thousands
/// of lines; serializing and shipping them all blocks the webview even with
/// frontend virtualization. Beyond this the diff is truncated and the UI offers
/// an explicit "show full diff" that re-requests it uncapped.
pub const DIFF_LINE_LIMIT: usize = 20_000;

/// Convert a `git2::Diff` into one `FileDiff` per delta, capping each file's
/// rendered lines at `limit` (`usize::MAX` for an uncapped "show full" request).
///
/// Uses [`Patch::from_diff`] for per-delta hunk/line access — this sidesteps
/// the borrow-checker friction of `Diff::foreach`'s multiple `FnMut` callbacks
/// and gives precise per-line numbers via [`Patch::line_in_hunk`].
pub(super) fn diffs_to_files(diff: &Diff, limit: usize) -> Result<Vec<FileDiff>, git2::Error> {
    let mut out = Vec::new();

    for idx in 0..diff.deltas().len() {
        let delta = match diff.get_delta(idx) {
            Some(d) => d,
            None => continue,
        };

        // Prefer the new-side path (handles renames / added files), fall back
        // to the old-side path (deletions).
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let status = status_letter(delta.status()).to_string();
        let binary = delta.flags().is_binary();

        let mut add = 0usize;
        let mut del = 0usize;
        let mut hunks = Vec::new();
        let mut truncated = false;

        if !binary {
            // `Patch::from_diff` returns `None` for binary / unmodified deltas.
            if let Some(patch) = Patch::from_diff(diff, idx)? {
                // Accurate add/del totals regardless of the content cap below, so
                // the +/- pills reflect the whole change even when truncated.
                let (_ctx, additions, deletions) = patch.line_stats()?;
                add = additions;
                del = deletions;

                let num_hunks = patch.num_hunks();
                let mut collected = 0usize;
                for h in 0..num_hunks {
                    let (hunk, line_count) = patch.hunk(h)?;
                    let header = {
                        let raw = String::from_utf8_lossy(hunk.header());
                        raw.trim_end_matches('\n')
                            .trim_end_matches('\r')
                            .to_string()
                    };
                    let mut lines = Vec::new();
                    for l in 0..line_count {
                        if collected >= limit {
                            truncated = true;
                            break;
                        }
                        lines.push(line_for(&patch.line_in_hunk(h, l)?));
                        collected += 1;
                    }
                    if !lines.is_empty() {
                        hunks.push(DiffHunk { header, lines });
                    }
                    if truncated {
                        break;
                    }
                }
            }
        }

        out.push(FileDiff {
            path,
            status,
            add,
            del,
            binary,
            hunks,
            truncated,
        });
    }

    Ok(out)
}

/// Convert a `git2::Diff` into `FileChange` summaries (path + status + counts),
/// without materialising the line content.
pub(super) fn diffs_to_changes(diff: &Diff) -> Result<Vec<FileChange>, git2::Error> {
    let mut out = Vec::new();

    for idx in 0..diff.deltas().len() {
        let delta = match diff.get_delta(idx) {
            Some(d) => d,
            None => continue,
        };
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let status = status_letter(delta.status()).to_string();

        let mut add = 0usize;
        let mut del = 0usize;
        if !delta.flags().is_binary() {
            if let Some(patch) = Patch::from_diff(diff, idx)? {
                let (_ctx, additions, deletions) = patch.line_stats()?;
                add = additions;
                del = deletions;
            }
        }

        out.push(FileChange {
            path,
            status,
            add,
            del,
        });
    }

    Ok(out)
}
