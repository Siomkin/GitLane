//! Shared libgit2 diff-to-DTO conversion helpers.

use git2::{Delta, Diff, DiffOptions, FileMode, Patch};

use crate::git::types::{
    ChangeStatus, DiffHunk, DiffLine, FileAdvancedState, FileChange, FileDiff,
    ADVANCED_KIND_SUBMODULE,
};

/// Map a `git2` delta status to the one-letter code the frontend expects.
/// The fallback is deliberate: libgit2's `Delta` has arms GitLane does not
/// model (untyped/ignored), and every one of them is "a change we render as
/// modified".
pub(super) fn status_letter(status: Delta) -> ChangeStatus {
    match status {
        Delta::Added => ChangeStatus::Added,
        Delta::Deleted => ChangeStatus::Deleted,
        Delta::Modified => ChangeStatus::Modified,
        Delta::Renamed => ChangeStatus::Renamed,
        Delta::Copied => ChangeStatus::Copied,
        Delta::Typechange => ChangeStatus::Typechange,
        Delta::Untracked => ChangeStatus::Untracked,
        _ => ChangeStatus::Modified,
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

/// Options for a one-file diff requested across IPC. libgit2 treats pathspecs
/// as fnmatch patterns by default; exact mode prevents a repository filename
/// such as `:(glob)*` or `*.rs` from selecting unrelated deltas.
pub(super) fn literal_file_options(file: &str) -> DiffOptions {
    let mut opts = DiffOptions::new();
    opts.pathspec(file)
        .disable_pathspec_match(true)
        .context_lines(3);
    opts
}

/// Render one `Patch` (from a tree diff or a blob pair) into accurate add/del
/// totals plus capped hunks. `add`/`del` come from `line_stats` so the +/− pills
/// stay truthful even when `hunks` is truncated at `limit`. Skips libgit2's
/// "\ No newline" pseudo-lines so the line indices match the staging backend.
pub(super) fn render_patch(
    patch: &Patch,
    limit: usize,
) -> Result<(usize, usize, Vec<DiffHunk>, bool), git2::Error> {
    let (_ctx, add, del) = patch.line_stats()?;

    let mut hunks = Vec::new();
    let mut truncated = false;
    let mut collected = 0usize;
    for h in 0..patch.num_hunks() {
        let (hunk, line_count) = patch.hunk(h)?;
        let header = {
            let raw = String::from_utf8_lossy(hunk.header());
            raw.trim_end_matches('\n')
                .trim_end_matches('\r')
                .to_string()
        };
        let mut lines = Vec::new();
        for l in 0..line_count {
            let dl = patch.line_in_hunk(h, l)?;
            if matches!(dl.origin(), '=' | '>' | '<') {
                continue;
            }
            if collected >= limit {
                truncated = true;
                break;
            }
            lines.push(line_for(&dl));
            collected += 1;
        }
        if !lines.is_empty() {
            hunks.push(DiffHunk { header, lines });
        }
        if truncated {
            break;
        }
    }

    Ok((add, del, hunks, truncated))
}

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

        let status = status_letter(delta.status());

        // Generating the patch is what makes libgit2 load blob content and decide
        // binariness (and fill in valid file sizes); a raw tree diff leaves the
        // flag unset, so read `is_binary` *after* this. Binary deltas come back as
        // `None` (no text patch) with the flag now set on the delta.
        let patch = Patch::from_diff(diff, idx)?;
        let binary = delta.flags().is_binary();

        // Every delta carries its side's blob oids so previews (binary images,
        // rendered markdown) can fetch content via `read_binary_blob`. Presence
        // keys off the delta status (added has no old side, deleted no new)
        // rather than the oid. Working-tree sides are unreliable by oid: a
        // binary side stays zero (content never loaded), and a text side gets a
        // *computed* hash that need not exist in the ODB — so consumers read
        // the working tree by path for unstaged diffs. Sizes stay binary-only:
        // they feed the "old → new (±delta)" card that replaces "+0 −0".
        let old_present = !matches!(delta.status(), Delta::Added | Delta::Untracked);
        let new_present = delta.status() != Delta::Deleted;
        let old = delta.old_file();
        let new = delta.new_file();
        let old_oid = (old_present && !old.id().is_zero()).then(|| old.id().to_string());
        let new_oid = (new_present && !new.id().is_zero()).then(|| new.id().to_string());
        let (old_size, new_size) = if binary {
            (
                old_present.then(|| old.size()),
                new_present.then(|| new.size()),
            )
        } else {
            (None, None)
        };

        // `patch` is `None` for binary deltas, so they stay at 0/0 with no hunks.
        let (add, del, hunks, truncated) = match patch {
            Some(patch) => render_patch(&patch, limit)?,
            None => (0, 0, Vec::new(), false),
        };

        out.push(FileDiff {
            path,
            status,
            add,
            del,
            binary,
            hunks,
            truncated,
            old_size,
            new_size,
            old_oid,
            new_oid,
            // Commit attribution is a per-commit-patch (gh) concept; libgit2
            // status diffs have no owning commit.
            ..Default::default()
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
        let status = status_letter(delta.status());

        // Build the patch first so libgit2 sets the binary flag (a raw tree diff
        // leaves it unknown); binary deltas yield `None` and stay at 0/0 counts.
        let patch = Patch::from_diff(diff, idx)?;
        let binary = delta.flags().is_binary();

        let mut add = 0usize;
        let mut del = 0usize;
        if let Some(patch) = patch {
            let (_ctx, additions, deletions) = patch.line_stats()?;
            add = additions;
            del = deletions;
        }

        // For a rename/copy the old side names the source path — carry it so
        // consumers can act on both paths (mirrors the working-tree buckets).
        let previous_path = matches!(delta.status(), Delta::Renamed | Delta::Copied)
            .then(|| {
                delta
                    .old_file()
                    .path()
                    .map(|p| p.to_string_lossy().to_string())
            })
            .flatten();

        // Gitlink (submodule) sides use FileMode::Commit. Tag them so committed
        // menus can hide Restore (ADR 0003) the same way working-tree rows do.
        let advanced = gitlink_advanced(&delta);

        out.push(FileChange {
            path,
            status,
            add,
            del,
            binary,
            line_count_truncated: false,
            previous_path,
            advanced,
        });
    }

    Ok(out)
}

fn gitlink_advanced(delta: &git2::DiffDelta<'_>) -> Option<FileAdvancedState> {
    let new_mode = delta.new_file().mode();
    let old_mode = delta.old_file().mode();
    if new_mode == FileMode::Commit || old_mode == FileMode::Commit {
        Some(FileAdvancedState {
            kind: ADVANCED_KIND_SUBMODULE.to_string(),
            message: "Submodule gitlink".to_string(),
        })
    } else {
        None
    }
}
