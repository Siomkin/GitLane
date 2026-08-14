//! Working-tree status and per-file working diff reads.

use git2::{DiffOptions, Repository, Status};

use crate::git::read::open;
use crate::git::types::{ChangeStatus, DiffHunk, DiffLine, FileChange, FileDiff, WorkingChanges};
use crate::git::worktree_fs::open_regular_worktree_file;

use super::advanced::{advanced_state, annotate_advanced_files};
use super::diff::{diffs_to_changes, diffs_to_files, literal_file_options, DIFF_LINE_LIMIT};

/// Resolve the HEAD commit's tree, if any (a fresh repo with no commits has
/// none).
fn head_tree(repo: &Repository) -> Option<git2::Tree<'_>> {
    repo.head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .and_then(|c| c.tree().ok())
}

/// True when the index entry for `path` is an intent-to-add record
/// (`git add -N`). libgit2 reports such paths as `INDEX_NEW | WT_MODIFIED`,
/// but git itself treats them as *unstaged* (` A` in porcelain, empty
/// `git diff --cached`, `git commit` refuses), so they must not land in the
/// staged bucket.
fn is_intent_to_add(index: Option<&git2::Index>, path: &str) -> bool {
    index
        .and_then(|ix| ix.get_path(std::path::Path::new(path), 0))
        .is_some_and(|e| {
            git2::IndexEntryExtendedFlag::from_bits_truncate(e.flags_extended)
                .contains(git2::IndexEntryExtendedFlag::INTENT_TO_ADD)
                // Some git versions record the entry with a null blob oid
                // instead of (or in addition to) the extended flag.
                || e.id.is_zero()
        })
}

/// Working-tree status split into staged (index vs HEAD) and unstaged
/// (worktree vs index) buckets. A file can appear in both.
pub fn working_changes(path: &str) -> Result<WorkingChanges, git2::Error> {
    let repo = open(path)?;

    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);

    let statuses = repo.statuses(Some(&mut opts))?;
    // Used only to detect intent-to-add entries. If the index can't be read
    // (should not happen for an open repo), detection degrades to "off" and an
    // intent-to-add file falls back to its libgit2 classification (staged "A")
    // rather than erroring the whole status read.
    let index = repo.index().ok();

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
            staged_counts.insert(fc.path.clone(), (fc.add, fc.del, fc.binary));
        }
    }

    let mut unstaged_counts = std::collections::HashMap::new();
    {
        let mut o = DiffOptions::new();
        o.include_untracked(true).recurse_untracked_dirs(true);
        let mut diff = repo.diff_index_to_workdir(None, Some(&mut o))?;
        // Mirror the status pass's index→workdir rename detection so a renamed
        // file's line counts group under one path instead of split add/del.
        // libgit2's status (with only renames_index_to_workdir set) runs
        // find_similar with RENAMES | FOR_UNTRACKED — the latter lets the new
        // side, an untracked file, be a rename target. Match exactly: adding
        // more (e.g. renames_from_rewrites) would detect renames the status
        // pass doesn't, so a path could be a rename here but split there and
        // the count lookup would miss.
        let mut find = git2::DiffFindOptions::new();
        find.renames(true).for_untracked(true);
        diff.find_similar(Some(&mut find))?;
        for fc in diffs_to_changes(&diff)? {
            unstaged_counts.insert(fc.path.clone(), (fc.add, fc.del, fc.binary));
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
                status: ChangeStatus::Conflicted,
                add: 0,
                del: 0,
                binary: false,
                line_count_truncated: false,
                previous_path: None,
                advanced: None,
            });
            continue;
        }

        // Prefer head-to-index path for staged, index-to-workdir for unstaged;
        // fall back to the plain entry path.
        let entry_path = entry.path().ok().unwrap_or("").to_string();

        let intent_to_add =
            s.contains(Status::INDEX_NEW) && is_intent_to_add(index.as_ref(), &entry_path);

        // ---- staged bucket (index vs HEAD) ----
        let staged_status = if s.contains(Status::INDEX_NEW) {
            // Intent-to-add records the path but stages no content — git
            // counts it as unstaged, so it belongs in the other bucket.
            (!intent_to_add).then_some(ChangeStatus::Added)
        } else if s.contains(Status::INDEX_MODIFIED) {
            Some(ChangeStatus::Modified)
        } else if s.contains(Status::INDEX_DELETED) {
            Some(ChangeStatus::Deleted)
        } else if s.contains(Status::INDEX_RENAMED) {
            Some(ChangeStatus::Renamed)
        } else if s.contains(Status::INDEX_TYPECHANGE) {
            Some(ChangeStatus::Typechange)
        } else {
            None
        };
        if let Some(st) = staged_status {
            let delta = entry.head_to_index();
            let p = delta
                .as_ref()
                .and_then(|d| {
                    d.new_file()
                        .path()
                        .or_else(|| d.old_file().path())
                        .map(|x| x.to_string_lossy().to_string())
                })
                .unwrap_or_else(|| entry_path.clone());
            // A staged rename carries the old path so unstaging it can restore
            // both sides at once — restoring only the new path would leave the
            // old path's deletion staged (the mirror of the GL-127 stage bug).
            let previous_path = (st == ChangeStatus::Renamed)
                .then(|| {
                    delta.and_then(|d| d.old_file().path().map(|x| x.to_string_lossy().to_string()))
                })
                .flatten();
            let (add, del, binary) = staged_counts.get(&p).copied().unwrap_or((0, 0, false));
            staged.push(FileChange {
                path: p,
                status: st,
                add,
                del,
                binary,
                line_count_truncated: false,
                previous_path,
                advanced: None,
            });
        }

        // ---- unstaged bucket (worktree vs index) ----
        let unstaged_status = if s.contains(Status::WT_NEW) {
            Some(ChangeStatus::Untracked)
        } else if s.contains(Status::WT_MODIFIED) {
            Some(ChangeStatus::Modified)
        } else if s.contains(Status::WT_DELETED) {
            Some(ChangeStatus::Deleted)
        } else if s.contains(Status::WT_RENAMED) {
            Some(ChangeStatus::Renamed)
        } else if s.contains(Status::WT_TYPECHANGE) {
            Some(ChangeStatus::Typechange)
        } else {
            None
        };
        // An intent-to-add path surfaces here as an unstaged addition (git's
        // ` A`) — libgit2 marks it WT_MODIFIED vs the recorded entry, or sets
        // no WT flag at all when the file is empty. A worktree deletion still
        // wins: the file is gone, not pending.
        let unstaged_status = if intent_to_add && unstaged_status != Some(ChangeStatus::Deleted) {
            Some(ChangeStatus::Added)
        } else {
            unstaged_status
        };
        if let Some(st) = unstaged_status {
            let delta = entry.index_to_workdir();
            let p = delta
                .as_ref()
                .and_then(|d| {
                    d.new_file()
                        .path()
                        .or_else(|| d.old_file().path())
                        .map(|x| x.to_string_lossy().to_string())
                })
                .unwrap_or_else(|| entry_path.clone());
            // A pure worktree rename (GL-114) shows as one "R" entry naming the
            // new path; carry the old path so staging it can add both sides at
            // once. Without this the old path's deletion stays unstaged after the
            // add — the GL-127 bug this field fixes.
            let previous_path = (st == ChangeStatus::Renamed)
                .then(|| {
                    delta.and_then(|d| d.old_file().path().map(|x| x.to_string_lossy().to_string()))
                })
                .flatten();
            let (mut add, del, mut binary) =
                unstaged_counts.get(&p).copied().unwrap_or((0, 0, false));
            let mut line_count_truncated = false;
            // Untracked files don't appear in the index-to-workdir diff stats
            // above unless include_untracked content was diffed; ensure a
            // sensible count by reading the file when needed. The same probe
            // also classifies the file as binary (a NUL byte), since libgit2
            // hasn't examined untracked content to set its own binary flag.
            // Intent-to-add additions get the same treatment — whether their
            // diff carries stats depends on how the entry was recorded.
            if (st == ChangeStatus::Untracked || st == ChangeStatus::Added) && add == 0 && del == 0
            {
                if let Some(wd) = repo.workdir() {
                    // Bound the probe so a huge untracked file can't block this
                    // synchronous command or balloon memory just to estimate a
                    // line count; files past the cap are counted approximately.
                    use std::io::Read;
                    const MAX_PROBE: u64 = 1 << 20; // 1 MiB
                    if let Ok(mut file) = open_regular_worktree_file(wd, &p) {
                        let exceeds_probe = file.len() > MAX_PROBE;
                        let mut buf = Vec::new();
                        if file.reader().take(MAX_PROBE).read_to_end(&mut buf).is_ok() {
                            if buf.contains(&0) {
                                binary = true;
                            } else {
                                add = String::from_utf8_lossy(&buf).lines().count();
                                line_count_truncated = exceeds_probe;
                            }
                        }
                    }
                }
            }
            unstaged.push(FileChange {
                path: p,
                status: st,
                add,
                del,
                binary,
                line_count_truncated,
                previous_path,
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

    let mut opts = literal_file_options(file);

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
    // Keep the exact-path selection defensive even though literal pathspec mode
    // should yield at most one delta.
    let result = files
        .iter()
        .position(|f| f.path == file)
        .map(|i| files.swap_remove(i))
        .or_else(|| files.pop());

    // libgit2's workdir diff doesn't reliably emit content hunks for untracked
    // files, so the list can report additions while this diff comes back empty.
    // When that happens for a brand-new file, synthesize the diff from disk.
    if !staged {
        let empty = result.as_ref().is_none_or(|f| f.hunks.is_empty());
        if empty
            && repo
                .status_file(std::path::Path::new(file))
                .is_ok_and(|s| s.contains(Status::WT_NEW))
        {
            if let Some(synth) = untracked_file_diff(&repo, file, limit) {
                return Ok(synth);
            }
        }
    }

    Ok(result.unwrap_or_else(|| FileDiff {
        path: file.to_string(),
        status: ChangeStatus::Modified,
        ..Default::default()
    }))
}

/// Build an all-added `FileDiff` for an untracked file straight from disk.
/// Used as a fallback because libgit2's index-to-workdir diff doesn't reliably
/// produce hunks for untracked content (see [`file_diff`]).
fn untracked_file_diff(repo: &Repository, file: &str, limit: usize) -> Option<FileDiff> {
    let workdir = repo.workdir()?;
    let mut opened = open_regular_worktree_file(workdir, file).ok()?;
    let mut bytes = Vec::with_capacity(opened.len().min(1024 * 1024) as usize);
    std::io::Read::read_to_end(opened.reader(), &mut bytes).ok()?;

    if bytes.contains(&0) {
        return Some(FileDiff {
            path: file.to_string(),
            status: ChangeStatus::Untracked,
            binary: true,
            // The whole file is "new" for an untracked add; surface its size so
            // the binary card shows "— → {size}" instead of an empty diff.
            new_size: Some(bytes.len() as u64),
            ..Default::default()
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
        status: ChangeStatus::Untracked,
        add: count,
        hunks,
        truncated,
        ..Default::default()
    })
}
