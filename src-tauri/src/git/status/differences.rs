//! One file's HEAD-to-working-tree diff split into differences, each tagged with
//! how much of it the index already holds (the commit review Include view).
//!
//! A difference is a block of changed lines in that diff. Its unstaged part is
//! found in working-tree line numbers (the new side of both it and the unstaged
//! diff) and its staged part in HEAD line numbers (the old side of both it and
//! the staged diff), so no offset translation between images is needed.

use crate::git::diff_blocks::{hunk_blocks, spans_touch, Block};
use crate::git::read::open;
use crate::git::types::{
    ChangeStatus, DiffLineRange, Difference, FileDiff, FileDifferences, Inclusion,
};

use super::diff::{diffs_to_files, literal_file_options, DIFF_LINE_LIMIT};
use super::working::{file_diff, head_tree};

/// Context for a whole-file diff: more than any file under `DIFF_LINE_LIMIT`
/// has lines, yet far from libgit2's integer limits.
const WHOLE_FILE_CONTEXT: u32 = 1 << 24;

/// `whole_file` renders the displayed diff with every line of the file as one
/// hunk; the `stage` / `unstage` targets still address the 3-context staged and
/// unstaged diffs, so only the presentation changes. A file too long to show
/// whole falls back to hunks with `whole_file: false`.
pub fn working_file_differences(
    path: &str,
    file: &str,
    whole_file: bool,
) -> Result<FileDifferences, git2::Error> {
    let staged = file_diff(path, file, true, false)?;
    let unstaged = file_diff(path, file, false, false)?;
    let mut shown_whole = whole_file;
    let diff = if unstaged.status == ChangeStatus::Untracked {
        unstaged.clone()
    } else if whole_file {
        let whole = head_to_worktree(path, file, WHOLE_FILE_CONTEXT)?;
        if whole.truncated {
            shown_whole = false;
            head_to_worktree(path, file, 3)?
        } else {
            whole
        }
    } else {
        head_to_worktree(path, file, 3)?
    };
    let differences = if splittable(&diff) && side_ok(&staged) && side_ok(&unstaged) {
        split(&diff, &staged, &unstaged).unwrap_or_default()
    } else {
        Vec::new()
    };
    Ok(FileDifferences {
        diff,
        differences,
        whole_file: shown_whole,
    })
}

fn head_to_worktree(path: &str, file: &str, context: u32) -> Result<FileDiff, git2::Error> {
    let repo = open(path)?;
    let head = head_tree(&repo);
    let mut opts = literal_file_options(file);
    opts.context_lines(context);
    let diff = repo.diff_tree_to_workdir_with_index(head.as_ref(), Some(&mut opts))?;
    let mut files = diffs_to_files(&diff, DIFF_LINE_LIMIT)?;
    Ok(files
        .iter()
        .position(|f| f.path == file)
        .map(|i| files.swap_remove(i))
        .unwrap_or_else(|| FileDiff {
            path: file.to_string(),
            status: ChangeStatus::Modified,
            ..Default::default()
        }))
}

/// Only a modified text diff, complete, can be included one difference at a time;
/// the staging-side rules in the frontend's `hunkPatchUnavailableReason` match.
fn splittable(diff: &FileDiff) -> bool {
    diff.status == ChangeStatus::Modified
        && !diff.binary
        && !diff.truncated
        && !diff.hunks.is_empty()
}

fn side_ok(side: &FileDiff) -> bool {
    side.hunks.is_empty() || (splittable(side) && side.add + side.del > 0)
}

struct SideBlock {
    hunk_index: usize,
    block: Block,
}

fn side_blocks(diff: &FileDiff) -> Option<Vec<SideBlock>> {
    let mut out = Vec::new();
    for (hunk_index, hunk) in diff.hunks.iter().enumerate() {
        let kinds: Vec<&str> = hunk.lines.iter().map(|l| l.kind.as_str()).collect();
        for block in hunk_blocks(&hunk.header, &kinds).ok()? {
            out.push(SideBlock { hunk_index, block });
        }
    }
    Some(out)
}

fn range(diff: &FileDiff, part: &SideBlock) -> DiffLineRange {
    DiffLineRange {
        hunk_index: part.hunk_index,
        line_start: part.block.line_start,
        expected: diff.hunks[part.hunk_index].lines[part.block.line_start..=part.block.line_end]
            .to_vec(),
    }
}

/// The changed lines of a block as `(kind, content)`, ignoring line numbers.
fn body<'a>(diff: &'a FileDiff, part: &SideBlock) -> Vec<(&'a str, &'a str)> {
    diff.hunks[part.hunk_index].lines[part.block.line_start..=part.block.line_end]
        .iter()
        .map(|l| (l.kind.as_str(), l.content.as_str()))
        .collect()
}

fn split(diff: &FileDiff, staged: &FileDiff, unstaged: &FileDiff) -> Option<Vec<Difference>> {
    let staged_blocks = side_blocks(staged)?;
    let unstaged_blocks = side_blocks(unstaged)?;
    let mut out = Vec::new();
    for part in side_blocks(diff)? {
        let unstaged_parts: Vec<&SideBlock> = unstaged_blocks
            .iter()
            .filter(|u| spans_touch(u.block.new, part.block.new))
            .collect();
        let staged_parts: Vec<&SideBlock> = staged_blocks
            .iter()
            .filter(|s| spans_touch(s.block.old, part.block.old))
            .collect();
        // Excluded also needs the unstaged block to be this exact change: it
        // enables revert, so any doubt falls back to partial.
        let exact_unstaged = matches!(unstaged_parts.as_slice(),
            [only] if body(unstaged, only) == body(diff, &part));
        let inclusion = match (staged_parts.is_empty(), unstaged_parts.is_empty()) {
            (true, false) if exact_unstaged => Inclusion::Excluded,
            (false, true) => Inclusion::Included,
            _ => Inclusion::Partial,
        };
        out.push(Difference {
            hunk_index: part.hunk_index,
            line_start: part.block.line_start,
            line_end: part.block.line_end,
            inclusion,
            stage: unstaged_parts.iter().map(|u| range(unstaged, u)).collect(),
            unstage: staged_parts.iter().map(|s| range(staged, s)).collect(),
        });
    }
    Some(out)
}
