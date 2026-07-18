//! Repository file listing + worktree text reads for the Files browser.
//!
//! The listing is what's actually on disk right now: tracked files from the
//! index (fast — no worktree walk), corrected by one status pass that adds
//! untracked (non-ignored) files and drops paths deleted from the worktree.
//! The text read serves the read-only file viewer; binary and oversized files
//! come back as flags, never as raw bytes.

use std::collections::BTreeSet;
use std::io::Read;

use git2::Status;

use crate::git::read::open;
use crate::git::types::RepoFileContent;
use crate::git::worktree_fs::open_regular_worktree_file;

/// Hard cap on bytes returned as viewer text. Beyond this the content is cut
/// at the cap (`truncated: true`) — a multi-megabyte string would stall the
/// webview for a file nobody scrolls to the end of.
const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024; // 2 MiB

/// How many leading bytes are sniffed for a NUL to classify a file as binary
/// (same heuristic git itself uses for diff text detection).
const BINARY_SNIFF_BYTES: usize = 8000;

/// Index mode for a gitlink (submodule commit) entry — `git ls-files -s` mode
/// `160000` octal. Such entries reference a directory, not a blob.
const GITLINK_MODE: u32 = 0o160000;

/// Every file in the repository worktree, repo-relative and sorted.
pub fn list_repo_files(path: &str) -> Result<Vec<String>, git2::Error> {
    let repo = open(path)?;

    let mut files: BTreeSet<String> = BTreeSet::new();
    for entry in repo.index()?.iter() {
        // Skip gitlinks (submodule commits): they list a directory the viewer
        // can't open (repo_file_text refuses non-regular files), so they'd only
        // appear as dead rows.
        if entry.mode == GITLINK_MODE {
            continue;
        }
        if let Ok(p) = std::str::from_utf8(&entry.path) {
            files.insert(p.to_string());
        }
    }

    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    for s in repo.statuses(Some(&mut opts))?.iter() {
        let Ok(p) = s.path() else { continue };
        let st = s.status();
        if st.contains(Status::WT_NEW) {
            files.insert(p.to_string());
        } else if st.contains(Status::WT_DELETED) {
            // In the index but gone from disk — the viewer couldn't open it.
            files.remove(p);
        }
    }

    Ok(files.into_iter().collect())
}

/// Read one worktree file's text for the viewer. `max_bytes` may only *lower*
/// the server cap, never raise it (mirrors `read_binary_blob`).
pub fn repo_file_text(
    path: &str,
    file: &str,
    max_bytes: Option<u64>,
) -> Result<RepoFileContent, git2::Error> {
    let repo = open(path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| git2::Error::from_str("repository has no working directory"))?;
    let mut opened = open_regular_worktree_file(workdir, file)
        .map_err(|e| git2::Error::from_str(&format!("open {file}: {e}")))?;

    let cap = max_bytes.map_or(MAX_TEXT_BYTES, |m| m.min(MAX_TEXT_BYTES));
    let size = opened.len();
    let truncated = size > cap;

    let mut bytes = Vec::with_capacity(size.min(cap) as usize);
    opened
        .reader()
        .take(cap)
        .read_to_end(&mut bytes)
        .map_err(|e| git2::Error::from_str(&format!("read {file}: {e}")))?;

    if bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
        return Ok(RepoFileContent {
            text: None,
            size,
            truncated: false,
            binary: true,
        });
    }

    Ok(RepoFileContent {
        // Lossy: a truncated read can split a multi-byte character at the cap;
        // the replacement char beats failing the whole view.
        text: Some(String::from_utf8_lossy(&bytes).into_owned()),
        size,
        truncated,
        binary: false,
    })
}

/// The committed (HEAD) text of `file`, for the viewer/editor's uncommitted-
/// change gutter markers — the baseline the current buffer is diffed against.
/// `None` when there is nothing to diff against: an unborn HEAD, a path absent
/// from HEAD (untracked/new), a non-blob (submodule/dir), or a binary/oversized
/// blob (the gutter simply shows no markers there).
pub fn repo_file_head_text(path: &str, file: &str) -> Result<Option<String>, git2::Error> {
    let repo = open(path)?;
    // Any failure to resolve HEAD → the committed blob just means "no baseline"
    // (the gutter shows no markers), never a surfaced error: unborn branch, a
    // broken symref/missing object, an absent path, or a non-blob entry.
    let Ok(head) = repo.head() else {
        return Ok(None);
    };
    let Ok(tree) = head.peel_to_commit().and_then(|c| c.tree()) else {
        return Ok(None);
    };
    let Ok(entry) = tree.get_path(std::path::Path::new(file)) else {
        return Ok(None); // not present at HEAD (untracked / newly added)
    };
    let Ok(object) = entry.to_object(&repo) else {
        return Ok(None);
    };
    let Some(blob) = object.as_blob() else {
        return Ok(None); // gitlink / tree — nothing to diff as text
    };
    let bytes = blob.content();
    if bytes.len() as u64 > MAX_TEXT_BYTES
        || bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0)
    {
        return Ok(None); // oversized or binary — no line-level baseline
    }
    Ok(Some(String::from_utf8_lossy(bytes).into_owned()))
}
