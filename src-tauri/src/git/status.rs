//! Working-tree status and diff reads via libgit2 (`git2`).
//!
//! Like [`super::read`], every function takes a filesystem path and opens the
//! repo fresh — `git2::Repository` is not `Send`, so we never hold one across
//! the async Tauri command boundary. Open, read, drop.

use git2::{Delta, Diff, DiffOptions, Oid, Patch, Repository, Status};

use super::read::open;
use super::types::{DiffHunk, DiffLine, FileChange, FileDiff, WorkingChanges};

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
fn diffs_to_files(diff: &Diff, limit: usize) -> Result<Vec<FileDiff>, git2::Error> {
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
fn diffs_to_changes(diff: &Diff) -> Result<Vec<FileChange>, git2::Error> {
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

    for entry in statuses.iter() {
        let s = entry.status();

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
            });
        }
    }

    Ok(WorkingChanges { staged, unstaged })
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

/// Resolve a commit's tree and its first parent's tree (or `None` for a root
/// commit) so a diff can be computed.
fn commit_trees<'repo>(
    repo: &'repo Repository,
    oid: &str,
) -> Result<(git2::Tree<'repo>, Option<git2::Tree<'repo>>), git2::Error> {
    let oid = Oid::from_str(oid)?;
    let commit = repo.find_commit(oid)?;
    let tree = commit.tree()?;
    let parent = commit.parent(0).ok().and_then(|p| p.tree().ok());
    Ok((tree, parent))
}

/// Changed files in a commit (diff vs its first parent, or the empty tree for a
/// root commit).
pub fn commit_files(path: &str, oid: &str) -> Result<Vec<FileChange>, git2::Error> {
    let repo = open(path)?;
    let (tree, parent) = commit_trees(&repo, oid)?;

    let mut opts = DiffOptions::new();
    let diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&tree), Some(&mut opts))?;
    diffs_to_changes(&diff)
}

/// Full diff for one file within a commit (vs its first parent).
pub fn commit_file_diff(
    path: &str,
    oid: &str,
    file: &str,
    full: bool,
) -> Result<FileDiff, git2::Error> {
    let repo = open(path)?;
    let (tree, parent) = commit_trees(&repo, oid)?;
    let limit = if full { usize::MAX } else { DIFF_LINE_LIMIT };

    let mut opts = DiffOptions::new();
    opts.pathspec(file).context_lines(3);
    let diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&tree), Some(&mut opts))?;

    let mut files = diffs_to_files(&diff, limit)?;
    Ok(files.pop().unwrap_or_else(|| FileDiff {
        path: file.to_string(),
        status: "M".to_string(),
        add: 0,
        del: 0,
        binary: false,
        hunks: Vec::new(),
        truncated: false,
    }))
}

/// Resolve any commit-ish (a SHA, "HEAD", a branch/tag name) to its tree.
/// Used by the range-diff helpers so they accept the same specifiers git does.
fn tree_for<'a>(repo: &'a Repository, spec: &str) -> Result<git2::Tree<'a>, git2::Error> {
    let obj = repo.revparse_single(spec)?;
    obj.peel_to_tree()
}

/// Changed files across a range `base..head`. Either side accepts any
/// commit-ish ("HEAD", a SHA, a branch), so this serves both "commit vs HEAD"
/// and "range between two commits". `base` is the older side (left tree).
pub fn diff_range(path: &str, base: &str, head: &str) -> Result<Vec<FileChange>, git2::Error> {
    let repo = open(path)?;
    let base_tree = tree_for(&repo, base)?;
    let head_tree = tree_for(&repo, head)?;

    let mut opts = DiffOptions::new();
    let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(&mut opts))?;
    diffs_to_changes(&diff)
}

/// Full diff for one file within a range `base..head` (see [`diff_range`]).
pub fn diff_range_file(
    path: &str,
    base: &str,
    head: &str,
    file: &str,
    full: bool,
) -> Result<FileDiff, git2::Error> {
    let repo = open(path)?;
    let base_tree = tree_for(&repo, base)?;
    let head_tree = tree_for(&repo, head)?;
    let limit = if full { usize::MAX } else { DIFF_LINE_LIMIT };

    let mut opts = DiffOptions::new();
    opts.pathspec(file).context_lines(3);
    let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(&mut opts))?;

    let mut files = diffs_to_files(&diff, limit)?;
    Ok(files.pop().unwrap_or_else(|| FileDiff {
        path: file.to_string(),
        status: "M".to_string(),
        add: 0,
        del: 0,
        binary: false,
        hunks: Vec::new(),
        truncated: false,
    }))
}

#[cfg(test)]
mod tests {
    use super::{commit_file_diff, DIFF_LINE_LIMIT};
    use git2::{Repository, Signature};
    use std::fs;
    use std::path::Path;

    fn commit(repo: &Repository, dir: &Path, name: &str, content: &str) -> git2::Oid {
        fs::write(dir.join(name), content).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(name)).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::now("Bench", "bench@example.test").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, name, &tree, &parents)
            .unwrap()
    }

    #[test]
    fn large_commit_diff_truncates_until_full_is_requested() {
        let dir = std::env::temp_dir().join("gitlane-diff-cap-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let repo = Repository::init(&dir).unwrap();
        commit(&repo, &dir, "seed.txt", "seed\n");

        let extra = 500;
        let big: String = (0..DIFF_LINE_LIMIT + extra)
            .map(|i| format!("line {i}\n"))
            .collect();
        let oid = commit(&repo, &dir, "big.txt", &big).to_string();
        let path = dir.to_str().unwrap();

        // Default: capped at the line limit, but the +add pill keeps the real total.
        let capped = commit_file_diff(path, &oid, "big.txt", false).unwrap();
        let shown: usize = capped.hunks.iter().map(|h| h.lines.len()).sum();
        assert!(capped.truncated);
        assert!(shown <= DIFF_LINE_LIMIT, "shown {shown}");
        assert_eq!(capped.add, DIFF_LINE_LIMIT + extra);

        // "Show full diff": uncapped, every line present.
        let full = commit_file_diff(path, &oid, "big.txt", true).unwrap();
        let full_shown: usize = full.hunks.iter().map(|h| h.lines.len()).sum();
        assert!(!full.truncated);
        assert_eq!(full_shown, DIFF_LINE_LIMIT + extra);

        let _ = fs::remove_dir_all(&dir);
    }
}
