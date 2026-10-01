//! Diffs for a path libgit2's *path-filtered* diff cannot render faithfully —
//! the two ways a path can look like a whole-file add when it isn't one: the new
//! side of a rename (whose source the pathspec filtered away, so nothing could
//! pair) and a genuinely new file (whose content libgit2 doesn't reliably emit
//! hunks for). Used as fallbacks by [`super::file_diff`]; the rename probe also
//! backs the ref-to-ref compare view (`status::compare::compare_file_diff`).

use std::io::Read;

use git2::{Delta, DiffOptions, Repository};

use crate::git::types::{ChangeStatus, DiffHunk, DiffLine, FileDiff};
use crate::git::worktree_fs::{open_regular_worktree_file, MAX_WORKTREE_TEXT_BYTES};

use crate::git::status::diff::delta_to_file;

/// The diff of `file` as the new side of a rename within `compare`, or `None`
/// when it isn't one. `compare` builds the comparison being rendered (HEAD→index,
/// index→worktree, tree→tree, …) with the given options; `find` is the rename
/// detection its file list used, so list and pane agree (`None` = libgit2's
/// defaults).
///
/// Rename detection needs *both* sides, and the caller's literal pathspec has
/// already dropped the old one. Rather than re-run the whole comparison, this
/// pairs against the deletions alone: a rename source is by definition a deleted
/// path, so a first pass collects those (deltas only — no content, no untracked
/// scan), and the second diff is filtered to `file` plus exactly those paths.
/// Similarity work is therefore bounded by the number of deletions, not by the
/// size of the dirty tree, and a comparison holding no deletion at all — the
/// common case for a genuinely new file — never reaches `find_similar`.
pub(in crate::git::status) fn renamed_diff<'r>(
    file: &str,
    limit: usize,
    compare: impl Fn(&mut DiffOptions) -> Result<git2::Diff<'r>, git2::Error>,
    find: Option<&mut git2::DiffFindOptions>,
) -> Result<Option<FileDiff>, git2::Error> {
    let deleted = deleted_paths(&compare)?;
    if deleted.is_empty() {
        return Ok(None);
    }

    let mut opts = DiffOptions::new();
    // Literal (non-fnmatch) pathspecs, as everywhere else a filename crosses
    // this boundary: a repository file named `*.rs` must not select its peers.
    opts.disable_pathspec_match(true).context_lines(3);
    opts.pathspec(file);
    for path in &deleted {
        opts.pathspec(path);
    }
    let mut diff = compare(&mut opts)?;
    diff.find_similar(find)?;

    let target = std::path::Path::new(file);
    let idx = (0..diff.deltas().len()).find(|&i| {
        diff.get_delta(i)
            .is_some_and(|d| d.status() == Delta::Renamed && d.new_file().path() == Some(target))
    });
    match idx {
        Some(idx) => delta_to_file(&diff, idx, limit),
        None => Ok(None),
    }
}

/// Old-side paths of every deletion in the comparison — the only candidates a
/// rename can pair with. Deltas only — no content is loaded.
fn deleted_paths<'r>(
    compare: &impl Fn(&mut DiffOptions) -> Result<git2::Diff<'r>, git2::Error>,
) -> Result<Vec<String>, git2::Error> {
    let mut opts = DiffOptions::new();
    let diff = compare(&mut opts)?;
    Ok(diff
        .deltas()
        .filter(|d| d.status() == Delta::Deleted)
        .filter_map(|d| d.old_file().path().map(|p| p.to_string_lossy().to_string()))
        .collect())
}

/// The comparison [`super::file_diff`] itself renders: HEAD→index when staged,
/// index→worktree otherwise. The untracked flags are what let the worktree side
/// see a rename's new path at all.
pub(super) fn comparison<'a>(
    repo: &'a Repository,
    staged: bool,
    opts: &mut DiffOptions,
) -> Result<git2::Diff<'a>, git2::Error> {
    if staged {
        let head = super::head_tree(repo);
        repo.diff_tree_to_index(head.as_ref(), None, Some(opts))
    } else {
        opts.include_untracked(true).recurse_untracked_dirs(true);
        repo.diff_index_to_workdir(None, Some(opts))
    }
}

/// Rename detection matching the pass [`super::working_changes`] counts with, so
/// the file list and this pane can never disagree about what is a rename. The
/// worktree side adds `for_untracked` because its new path is, by definition,
/// not in the index yet; the staged side takes libgit2's plain rename defaults.
pub(super) fn find_options(staged: bool) -> git2::DiffFindOptions {
    let mut find = git2::DiffFindOptions::new();
    find.renames(true);
    if !staged {
        find.for_untracked(true);
    }
    find
}

/// Build an all-added `FileDiff` for an untracked file straight from disk.
/// Used as a fallback because libgit2's index-to-workdir diff doesn't reliably
/// produce hunks for untracked content (see [`super::file_diff`]).
pub(super) fn untracked_file_diff(repo: &Repository, file: &str, limit: usize) -> Option<FileDiff> {
    let workdir = repo.workdir()?;
    let mut opened = open_regular_worktree_file(workdir, file).ok()?;
    let size = opened.len();
    // Read at most the cap: only `limit` lines are rendered anyway, so a
    // multi-GB untracked file must not be allocated whole just to be cut.
    let cut = size > MAX_WORKTREE_TEXT_BYTES as u64;
    let mut bytes = Vec::with_capacity(size.min(1024 * 1024) as usize);
    opened
        .reader()
        .take(MAX_WORKTREE_TEXT_BYTES as u64)
        .read_to_end(&mut bytes)
        .ok()?;

    if bytes.contains(&0) {
        return Some(FileDiff {
            path: file.to_string(),
            status: ChangeStatus::Untracked,
            binary: true,
            // The whole file is "new" for an untracked add; surface its size so
            // the binary card shows "— → {size}" instead of an empty diff.
            new_size: Some(size),
            ..Default::default()
        });
    }

    let text = String::from_utf8_lossy(&bytes);
    // `add` is the file's real line count (a floor past the byte cap); only the
    // first `limit` are rendered.
    let count = text.lines().count();
    let truncated = cut || count > limit;
    let lines: Vec<DiffLine> = text
        .lines()
        .take(limit)
        .enumerate()
        .map(|(i, raw)| DiffLine {
            kind: "add".to_string(),
            old_no: None,
            new_no: Some(i as u32 + 1),
            content: raw.to_string(),
        })
        .collect();

    let hunks = if lines.is_empty() {
        Vec::new()
    } else {
        vec![DiffHunk {
            header: format!("@@ -0,0 +1,{count} @@"),
            lines,
        }]
    };

    Some(FileDiff {
        path: file.to_string(),
        status: ChangeStatus::Untracked,
        add: count,
        hunks,
        truncated,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::untracked_file_diff;
    use crate::git::worktree_fs::MAX_WORKTREE_TEXT_BYTES;

    #[test]
    fn an_untracked_file_past_the_byte_cap_is_read_only_up_to_the_cap() {
        // Even an uncapped (`full`) line limit must not allocate a huge
        // untracked file whole: the read stops at the byte cap and says so.
        let dir = std::env::temp_dir().join("gitlane-untracked-byte-cap-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = git2::Repository::init(&dir).unwrap();
        let lines = MAX_WORKTREE_TEXT_BYTES / 2 + 100;
        std::fs::write(dir.join("huge.log"), "x\n".repeat(lines)).unwrap();

        let diff = untracked_file_diff(&repo, "huge.log", usize::MAX).unwrap();
        assert!(diff.truncated);
        assert_eq!(diff.add, MAX_WORKTREE_TEXT_BYTES / 2);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
