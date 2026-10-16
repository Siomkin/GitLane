//! Stage, unstage, or revert contiguous line ranges of a displayed diff, all
//! ranges of one request as a single patch so they move together or not at all.

use std::collections::BTreeMap;

use super::super::cli::{run_git_stdout_raw, run_git_with_bytes};
use super::extract::{find_hunk, is_mode_change_line, parse_hunk_lines, partial_hunk};
use super::runners::{apply_hunk_patch, patch_diff_args};
use crate::git::diff_blocks::{hunk_blocks, spans_touch, Span};
use crate::git::types::{ApplyLineRangeRequest, DiffLineRange};
use crate::git::write::classify::stale;

/// Stage the ranges from the worktree diff, or unstage them from the staged
/// diff when `staged` is true. Every displayed line is re-checked first.
pub fn apply_line_range(repo: &str, request: &ApplyLineRangeRequest) -> Result<String, String> {
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    let diff = run_git_stdout_raw(repo, &patch_diff_args(request.staged, &request.file))?;
    let patch = extract_line_range_patch(&diff, &request.ranges, request.staged)?;
    apply_hunk_patch(repo, &patch, request.staged)?;
    Ok(format!(
        "{} lines in {}",
        if request.staged { "Unstaged" } else { "Staged" },
        request.file
    ))
}

/// Restore the ranges of the worktree diff to the index content in the working
/// tree. The index is never touched, and a range next to staged content is
/// refused: restoring it would split a change the user sees as one.
pub fn revert_line_range(repo: &str, request: &ApplyLineRangeRequest) -> Result<String, String> {
    if request.staged {
        return Err("Only unstaged changes can be reverted".to_string());
    }
    let _index_guard = super::super::index_lock::lock_index_writes(repo)?;
    let diff = run_git_stdout_raw(repo, &patch_diff_args(false, &request.file))?;
    // Reversed, so the preimage is the working tree the patch is applied to.
    let patch = extract_line_range_patch(&diff, &request.ranges, true)?;
    let staged = run_git_stdout_raw(repo, &patch_diff_args(true, &request.file))?;
    if touches_staged(&diff, &request.ranges, &staged)? {
        return Err("Part of this change is staged; exclude it before reverting".to_string());
    }
    run_git_with_bytes(
        repo,
        &["apply", "--reverse", "--whitespace=nowarn", "-"],
        &patch,
    )?;
    Ok(format!("Reverted lines in {}", request.file))
}

/// One patch holding every range, one fragment per hunk, after checking each
/// range's lines against what the UI displayed.
pub(super) fn extract_line_range_patch(
    diff: &[u8],
    ranges: &[DiffLineRange],
    reverse: bool,
) -> Result<Vec<u8>, String> {
    if ranges.is_empty() {
        return Err("No lines were selected".to_string());
    }
    let mut by_hunk: BTreeMap<usize, Vec<&DiffLineRange>> = BTreeMap::new();
    for range in ranges {
        by_hunk.entry(range.hunk_index).or_default().push(range);
    }

    let mut patch: Vec<u8> = Vec::new();
    for (position, (hunk_index, hunk_ranges)) in by_hunk.into_iter().enumerate() {
        let (file_header, hunk_header, raw_lines) = find_hunk(diff, hunk_index)?;
        let lines = parse_hunk_lines(&hunk_header, &raw_lines)?;
        for range in &hunk_ranges {
            if range.expected.is_empty() {
                return Err("No lines were selected".to_string());
            }
            for (offset, expected) in range.expected.iter().enumerate() {
                let Some(actual) = lines.get(range.line_start + offset) else {
                    return Err(stale("Those lines are no longer available."));
                };
                if actual.kind != expected.kind
                    || actual.content != expected.content
                    || actual.old_no != expected.old_no
                    || actual.new_no != expected.new_no
                {
                    return Err(stale("Those lines changed on disk."));
                }
            }
        }
        if position == 0 {
            for line in file_header.into_iter().filter(|l| !is_mode_change_line(l)) {
                patch.extend_from_slice(line);
            }
        }
        let selected = |index: usize| {
            hunk_ranges
                .iter()
                .any(|r| (r.line_start..r.line_start + r.expected.len()).contains(&index))
        };
        patch.extend_from_slice(&partial_hunk(&lines, &selected, &hunk_header, reverse)?);
    }
    if !patch.ends_with(b"\n") {
        patch.push(b'\n');
    }
    Ok(patch)
}

/// Whether any block the unstaged ranges cover touches a staged block, compared
/// in index line numbers (the old side of the unstaged diff, the new side of the
/// staged one).
fn touches_staged(
    unstaged: &[u8],
    ranges: &[DiffLineRange],
    staged: &[u8],
) -> Result<bool, String> {
    let mut covered: Vec<Span> = Vec::new();
    for range in ranges {
        let end = range.line_start + range.expected.len();
        covered.extend(
            blocks_of(unstaged, range.hunk_index)?
                .into_iter()
                .filter(|b| b.line_start < end && range.line_start <= b.line_end)
                .map(|b| b.old),
        );
    }
    let mut staged_spans: Vec<Span> = Vec::new();
    for hunk_index in 0.. {
        match find_hunk(staged, hunk_index) {
            Ok(_) => staged_spans.extend(blocks_of(staged, hunk_index)?.into_iter().map(|b| b.new)),
            Err(_) => break,
        }
    }
    Ok(covered
        .iter()
        .any(|c| staged_spans.iter().any(|s| spans_touch(*c, *s))))
}

fn blocks_of(
    diff: &[u8],
    hunk_index: usize,
) -> Result<Vec<crate::git::diff_blocks::Block>, String> {
    let (_, header, raw_lines) = find_hunk(diff, hunk_index)?;
    let lines = parse_hunk_lines(&header, &raw_lines)?;
    let kinds: Vec<&str> = lines.iter().map(|l| l.kind).collect();
    hunk_blocks(&header, &kinds)
}
