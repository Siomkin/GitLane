//! File-history and blame reads.

use std::path::{Path, PathBuf};

use git2::{BlameOptions, Delta, DiffOptions, Oid, Repository};

use crate::git::read::open;
use crate::git::types::{BlameLine, FileBlame, FileHistoryEntry, FileHistoryPage};

use super::diff::status_letter;

const DEFAULT_HISTORY_LIMIT: usize = 100;
const MAX_HISTORY_LIMIT: usize = 500;
const HISTORY_SCAN_CAP: usize = 5_000;
const DEFAULT_BLAME_LIMIT: usize = 2_000;
const MAX_BLAME_LIMIT: usize = 10_000;
const NON_UTF8_TEXT_ERROR: &str = "file is not UTF-8 text";

fn path_string(path: Option<&Path>) -> Option<String> {
    path.map(|p| p.to_string_lossy().into_owned())
}

fn short_oid(oid: Oid) -> String {
    oid.to_string().chars().take(7).collect()
}

#[allow(clippy::too_many_arguments)]
fn commit_entry(
    commit: &git2::Commit<'_>,
    status: Delta,
    path: String,
    previous_path: Option<String>,
    add: usize,
    del: usize,
) -> FileHistoryEntry {
    let oid = commit.id();
    FileHistoryEntry {
        oid: oid.to_string(),
        short_oid: short_oid(oid),
        subject: commit.summary().ok().flatten().unwrap_or("").to_string(),
        body: commit.body().ok().flatten().unwrap_or("").to_string(),
        author_name: commit.author().name().ok().unwrap_or("").to_string(),
        author_email: commit.author().email().ok().unwrap_or("").to_string(),
        timestamp: commit.time().seconds(),
        status: status_letter(status),
        path,
        add,
        del,
        previous_path,
    }
}

/// Bounded newest-first history for `file`, following detected renames backward.
pub fn file_history(
    path: &str,
    file: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<FileHistoryPage, git2::Error> {
    let repo = open(path)?;
    let requested = limit
        .unwrap_or(DEFAULT_HISTORY_LIMIT)
        .clamp(1, MAX_HISTORY_LIMIT);
    let skip = offset.unwrap_or(0);
    let mut current_path = file.to_string();
    let mut seen_matches = 0usize;
    let mut scanned = 0usize;
    let mut entries = Vec::new();

    let mut walk = repo.revwalk()?;
    walk.push_head()?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL)?;

    for oid in walk {
        if scanned >= HISTORY_SCAN_CAP {
            break;
        }
        scanned += 1;
        let oid = oid?;
        let commit = repo.find_commit(oid)?;
        let tree = commit.tree()?;
        let parent = commit.parent(0).ok().and_then(|p| p.tree().ok());

        let mut opts = DiffOptions::new();
        let mut diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&tree), Some(&mut opts))?;
        diff.find_similar(None)?;

        for (idx, delta) in diff.deltas().enumerate() {
            let old_path = path_string(delta.old_file().path());
            let new_path = path_string(delta.new_file().path());
            let delta_path = match delta.status() {
                Delta::Deleted => old_path.clone(),
                _ => new_path.clone().or(old_path.clone()),
            };
            let Some(delta_path) = delta_path else {
                continue;
            };
            if delta_path != current_path && old_path.as_deref() != Some(current_path.as_str()) {
                continue;
            }

            let previous_path = if delta.status() == Delta::Renamed {
                old_path.filter(|p| p != &current_path)
            } else {
                None
            };
            let (add, del) = git2::Patch::from_diff(&diff, idx)
                .ok()
                .flatten()
                .and_then(|p| p.line_stats().ok())
                .map(|(_ctx, add, del)| (add, del))
                .unwrap_or((0, 0));
            if seen_matches >= skip {
                entries.push(commit_entry(
                    &commit,
                    delta.status(),
                    delta_path,
                    previous_path.clone(),
                    add,
                    del,
                ));
            }
            seen_matches += 1;
            if let Some(prev) = previous_path {
                current_path = prev;
            }
            break;
        }

        if entries.len() > requested {
            break;
        }
    }

    let has_more = entries.len() > requested;
    if has_more {
        entries.truncate(requested);
    }
    Ok(FileHistoryPage {
        next_offset: skip + entries.len(),
        entries,
        has_more,
        truncated: scanned >= HISTORY_SCAN_CAP,
    })
}

fn blob_text_at(
    repo: &Repository,
    revision: Option<&str>,
    file: &str,
) -> Result<Vec<String>, git2::Error> {
    let bytes = if let Some(revision) = revision {
        let tree = repo.revparse_single(revision)?.peel_to_tree()?;
        let entry = tree.get_path(Path::new(file))?;
        let blob = repo.find_blob(entry.id())?;
        blob.content().to_vec()
    } else {
        let workdir = repo
            .workdir()
            .ok_or_else(|| git2::Error::from_str("repository has no working tree"))?;
        crate::git::worktree_fs::read_regular_worktree_file(workdir, file)
            .map_err(|e| git2::Error::from_str(&format!("read {file}: {e}")))?
    };
    let text = String::from_utf8(bytes).map_err(|_| git2::Error::from_str(NON_UTF8_TEXT_ERROR))?;
    Ok(text.lines().map(|line| line.to_string()).collect())
}

/// Blame a text file at `revision` or the working tree. Working-tree blame uses
/// HEAD attribution for unchanged lines and the current file content for display.
pub fn file_blame(
    path: &str,
    file: &str,
    revision: Option<String>,
    limit: Option<usize>,
) -> Result<FileBlame, git2::Error> {
    let repo = open(path)?;
    let requested = limit
        .unwrap_or(DEFAULT_BLAME_LIMIT)
        .clamp(1, MAX_BLAME_LIMIT);
    let mut opts = BlameOptions::new();
    if let Some(revision) = revision.as_deref() {
        let oid = repo.revparse_single(revision)?.peel_to_commit()?.id();
        opts.newest_commit(oid);
    }

    let blame = repo.blame_file(Path::new(file), Some(&mut opts))?;
    let content = match blob_text_at(&repo, revision.as_deref(), file) {
        Ok(lines) => lines,
        Err(err) if err.message() == NON_UTF8_TEXT_ERROR => {
            return Ok(FileBlame {
                path: file.to_string(),
                revision,
                binary: true,
                truncated: false,
                lines: Vec::new(),
            });
        }
        Err(err) => return Err(err),
    };

    let truncated = content.len() > requested;
    let mut lines = Vec::with_capacity(content.len().min(requested));
    for (idx, text) in content.into_iter().take(requested).enumerate() {
        let line_no = idx + 1;
        let Some(hunk) = blame.get_line(line_no) else {
            lines.push(BlameLine {
                line_no,
                content: text,
                oid: String::new(),
                short_oid: "worktree".to_string(),
                subject: String::new(),
                author_name: "Uncommitted".to_string(),
                author_email: String::new(),
                timestamp: 0,
                original_path: file.to_string(),
                original_line: line_no,
            });
            continue;
        };
        let oid = hunk.final_commit_id();
        let sig = hunk.final_signature();
        let subject = repo
            .find_commit(oid)
            .ok()
            .and_then(|c| c.summary().ok().flatten().map(|s| s.to_string()))
            .unwrap_or_default();
        lines.push(BlameLine {
            line_no,
            content: text,
            oid: oid.to_string(),
            short_oid: short_oid(oid),
            subject,
            author_name: sig
                .as_ref()
                .and_then(|s| s.name().ok())
                .unwrap_or("")
                .to_string(),
            author_email: sig
                .as_ref()
                .and_then(|s| s.email().ok())
                .unwrap_or("")
                .to_string(),
            timestamp: sig.as_ref().map(|s| s.when().seconds()).unwrap_or(0),
            original_path: hunk
                .path()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(file))
                .to_string_lossy()
                .into_owned(),
            original_line: hunk.orig_start_line(),
        });
    }

    Ok(FileBlame {
        path: file.to_string(),
        revision,
        binary: false,
        truncated,
        lines,
    })
}
