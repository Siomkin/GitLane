//! Working-tree status and per-file working diff reads.

use git2::{DiffOptions, Repository, Status};

use crate::git::read::open;
use crate::git::types::{DiffHunk, DiffLine, FileChange, FileDiff, WorkingChanges};

use super::advanced::{advanced_state, annotate_advanced_files};
use super::diff::{diffs_to_changes, diffs_to_files, DIFF_LINE_LIMIT};

/// Resolve the HEAD commit's tree, if any (a fresh repo with no commits has
/// none).
fn head_tree(repo: &Repository) -> Option<git2::Tree<'_>> {
    repo.head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .and_then(|c| c.tree().ok())
}

/// Working-tree status split into staged (index vs HEAD) and unstaged
/// (worktree vs index) buckets. A file can appear in both.
pub fn working_changes(path: &str) -> Result<WorkingChanges, git2::Error> {
    let repo = open(path)?;

    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true);

    let statuses = repo.statuses(Some(&mut opts))?;

    // Line counts come from two diffs computed once, indexed by path.
    let head = head_tree(&repo);

    let mut staged_counts = std::collections::HashMap::new();
    {
        let mut o = DiffOptions::new();
        let mut diff = repo.diff_tree_to_index(head.as_ref(), None, Some(&mut o))?;
        // Match the status pass's head→index rename detection so a renamed file's
        // line counts are grouped under one path instead of split add/del.
        diff.find_similar(None)?;
        for fc in diffs_to_changes(&diff)? {
            staged_counts.insert(fc.path.clone(), (fc.add, fc.del));
        }
    }

    let mut unstaged_counts = std::collections::HashMap::new();
    {
        let mut o = DiffOptions::new();
        o.include_untracked(true).recurse_untracked_dirs(true);
        let diff = repo.diff_index_to_workdir(None, Some(&mut o))?;
        for fc in diffs_to_changes(&diff)? {
            unstaged_counts.insert(fc.path.clone(), (fc.add, fc.del));
        }
    }

    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut conflicted = Vec::new();

    for entry in statuses.iter() {
        let s = entry.status();

        // Unmerged (conflicted) paths are owned by the dedicated conflict
        // workflow (`git::conflicts` + the in-app ConflictWorkspace), not the
        // ordinary stage/unstage view — surfacing them in those buckets would
        // invite normal staging semantics on a file git still considers
        // unresolved. They go in their own bucket instead of being dropped, so
        // they stay visible (and detectable) even when the operation that owns
        // them isn't detected — e.g. `git am`/`bisect`, or a transient
        // `operation_status` failure — rather than vanishing from the UI.
        if s.contains(Status::CONFLICTED) {
            conflicted.push(FileChange {
                path: entry.path().ok().unwrap_or("").to_string(),
                status: "C".to_string(),
                add: 0,
                del: 0,
                advanced: None,
            });
            continue;
        }

        // Prefer head-to-index path for staged, index-to-workdir for unstaged;
        // fall back to the plain entry path.
        let entry_path = entry.path().ok().unwrap_or("").to_string();

        // ---- staged bucket (index vs HEAD) ----
        let staged_status = if s.contains(Status::INDEX_NEW) {
            Some("A")
        } else if s.contains(Status::INDEX_MODIFIED) {
            Some("M")
        } else if s.contains(Status::INDEX_DELETED) {
            Some("D")
        } else if s.contains(Status::INDEX_RENAMED) {
            Some("R")
        } else if s.contains(Status::INDEX_TYPECHANGE) {
            Some("T")
        } else {
            None
        };
        if let Some(st) = staged_status {
            let p = entry
                .head_to_index()
                .and_then(|d| {
                    d.new_file()
                        .path()
                        .or_else(|| d.old_file().path())
                        .map(|x| x.to_string_lossy().to_string())
                })
                .unwrap_or_else(|| entry_path.clone());
            let (add, del) = staged_counts.get(&p).copied().unwrap_or((0, 0));
            staged.push(FileChange {
                path: p,
                status: st.to_string(),
                add,
                del,
                advanced: None,
            });
        }

        // ---- unstaged bucket (worktree vs index) ----
        let unstaged_status = if s.contains(Status::WT_NEW) {
            Some("U")
        } else if s.contains(Status::WT_MODIFIED) {
            Some("M")
        } else if s.contains(Status::WT_DELETED) {
            Some("D")
        } else if s.contains(Status::WT_RENAMED) {
            Some("R")
        } else if s.contains(Status::WT_TYPECHANGE) {
            Some("T")
        } else {
            None
        };
        if let Some(st) = unstaged_status {
            let p = entry
                .index_to_workdir()
                .and_then(|d| {
                    d.new_file()
                        .path()
                        .or_else(|| d.old_file().path())
                        .map(|x| x.to_string_lossy().to_string())
                })
                .unwrap_or_else(|| entry_path.clone());
            let (mut add, del) = unstaged_counts.get(&p).copied().unwrap_or((0, 0));
            // Untracked files don't appear in the index-to-workdir diff stats
            // above unless include_untracked content was diffed; ensure a
            // sensible count by reading the file when needed.
            if st == "U" && add == 0 && del == 0 {
                if let Some(wd) = repo.workdir() {
                    // Bound the probe so a huge untracked file can't block this
                    // synchronous command or balloon memory just to estimate a
                    // line count; files past the cap are counted approximately.
                    use std::io::Read;
                    const MAX_PROBE: u64 = 1 << 20; // 1 MiB
                    if let Ok(file) = std::fs::File::open(wd.join(&p)) {
                        let mut buf = Vec::new();
                        if file.take(MAX_PROBE).read_to_end(&mut buf).is_ok() && !buf.contains(&0) {
                            add = String::from_utf8_lossy(&buf).lines().count();
                        }
                    }
                }
            }
            unstaged.push(FileChange {
                path: p,
                status: st.to_string(),
                add,
                del,
                advanced: None,
            });
        }
    }

    let changed_paths: Vec<String> = staged
        .iter()
        .chain(unstaged.iter())
        .chain(conflicted.iter())
        .map(|change| change.path.clone())
        .collect();
    let advanced = advanced_state(&repo, &changed_paths);
    annotate_advanced_files(&repo, &mut staged, &advanced);
    annotate_advanced_files(&repo, &mut unstaged, &advanced);

    Ok(WorkingChanges {
        staged,
        unstaged,
        conflicted,
        advanced,
    })
}

/// Diff for a single working-tree file. `staged` true → HEAD-tree vs index;
/// false → index vs workdir (with untracked content shown).
pub fn file_diff(
    path: &str,
    file: &str,
    staged: bool,
    full: bool,
) -> Result<FileDiff, git2::Error> {
    let repo = open(path)?;
    let limit = if full { usize::MAX } else { DIFF_LINE_LIMIT };

    let mut opts = DiffOptions::new();
    opts.pathspec(file).context_lines(3);

    let diff = if staged {
        let head = head_tree(&repo);
        repo.diff_tree_to_index(head.as_ref(), None, Some(&mut opts))?
    } else {
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            .show_untracked_content(true);
        repo.diff_index_to_workdir(None, Some(&mut opts))?
    };

    let mut files = diffs_to_files(&diff, limit)?;
    // The pathspec can match more than one delta (e.g. a path that prefixes
    // others); pick the delta whose path matches `file` rather than blindly
    // taking the last, falling back to the last only when nothing matches.
    let result = files
        .iter()
        .position(|f| f.path == file)
        .map(|i| files.swap_remove(i))
        .or_else(|| files.pop());

    // libgit2's workdir diff doesn't reliably emit content hunks for untracked
    // files, so the list can report additions while this diff comes back empty.
    // When that happens for a brand-new file, synthesize the diff from disk.
    if !staged {
        let empty = result.as_ref().map_or(true, |f| f.hunks.is_empty());
        if empty
            && repo
                .status_file(std::path::Path::new(file))
                .map_or(false, |s| s.contains(Status::WT_NEW))
        {
            if let Some(synth) = untracked_file_diff(&repo, file, limit) {
                return Ok(synth);
            }
        }
    }

    Ok(result.unwrap_or_else(|| FileDiff {
        path: file.to_string(),
        status: "M".to_string(),
        add: 0,
        del: 0,
        binary: false,
        hunks: Vec::new(),
        truncated: false,
    }))
}

/// Build an all-added `FileDiff` for an untracked file straight from disk.
/// Used as a fallback because libgit2's index-to-workdir diff doesn't reliably
/// produce hunks for untracked content (see [`file_diff`]).
fn untracked_file_diff(repo: &Repository, file: &str, limit: usize) -> Option<FileDiff> {
    let workdir = repo.workdir()?;
    let bytes = std::fs::read(workdir.join(file)).ok()?;

    if bytes.contains(&0) {
        return Some(FileDiff {
            path: file.to_string(),
            status: "U".to_string(),
            add: 0,
            del: 0,
            binary: true,
            hunks: Vec::new(),
            truncated: false,
        });
    }

    let text = String::from_utf8_lossy(&bytes);
    // `add` is the file's real line count; only the first `limit` are rendered.
    let count = text.lines().count();
    let truncated = count > limit;
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
        status: "U".to_string(),
        add: count,
        del: 0,
        binary: false,
        hunks,
        truncated,
    })
}
