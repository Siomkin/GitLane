//! Worktree content reads for conflicted text files.

use std::io::Read;
use std::path::Path;

use crate::git::read::open;
use crate::git::types::ConflictFileContent;
use crate::git::worktree_fs::{open_worktree_file, MAX_WORKTREE_TEXT_BYTES};

/// The worktree copy of a conflicted text file, including git's merge markers,
/// for the in-app editor to parse. Binary files come back with empty content and
/// `binary: true` (the UI offers a whole-file choice instead of a line editor);
/// files past [`MAX_WORKTREE_TEXT_BYTES`] come back the same way plus
/// `too_large: true`, so the UI can say why.
///
/// `resolved` reads a conflicted file the user has already staged (its
/// resolution as it now sits in the worktree) under the same cap, so a file
/// keeps its card when it is staged.
pub fn conflict_file(
    path: &str,
    file: &str,
    resolved: bool,
) -> Result<ConflictFileContent, git2::Error> {
    let repo = open(path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| git2::Error::from_str("bare repository has no worktree"))?;
    // Only a genuine unmerged path (or, once resolved, a staged one) may be read
    // here — not any safe relative file.
    let index = repo.index()?;
    let readable = if resolved {
        index.get_path(Path::new(file), 0).is_some()
    } else {
        index.conflicts()?.flatten().any(|c| {
            c.our
                .as_ref()
                .or(c.their.as_ref())
                .or(c.ancestor.as_ref())
                .is_some_and(|entry| &*String::from_utf8_lossy(&entry.path) == file)
        })
    };
    if !readable {
        let what = if resolved { "staged" } else { "conflicted" };
        return Err(git2::Error::from_str(&format!(
            "{file:?} is not a {what} path"
        )));
    }
    let whole_file = |binary: bool, too_large: bool| ConflictFileContent {
        path: file.to_string(),
        content: String::new(),
        binary,
        too_large,
    };
    // Never follow a symlink (or read a non-regular entry like a submodule
    // directory): a conflicted symlink's worktree entry can point outside the
    // repo (e.g. `link -> /etc/passwd`), and `fs::read` would follow it past the
    // traversal guard above. Report it as binary — the whole-file picker, which
    // never round-trips the worktree bytes — instead of reading the target.
    let Some(mut opened) = open_worktree_file(workdir, file)
        .map_err(|e| git2::Error::from_str(&format!("open {file}: {e}")))?
    else {
        return Ok(whole_file(true, false));
    };
    let mut bytes = Vec::with_capacity(opened.len().min(1024 * 1024) as usize);
    opened
        .reader()
        .take(MAX_WORKTREE_TEXT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| git2::Error::from_str(&format!("read {file}: {e}")))?;
    // Past the cap the text can't be edited whole, and a cut copy written back
    // would lose the tail — route it to the whole-file picker like a binary,
    // flagged too large so the UI can say why.
    if bytes.len() > MAX_WORKTREE_TEXT_BYTES {
        return Ok(whole_file(true, true));
    }
    // Treat NUL-containing or non-UTF-8 files as binary. Lossy-decoding invalid
    // UTF-8 would replace bytes with U+FFFD and silently corrupt the file when
    // the resolved text is written back; a binary classification routes to the
    // whole-file side picker (which never round-trips the bytes through a String).
    if bytes.contains(&0) {
        return Ok(whole_file(true, false));
    }
    match String::from_utf8(bytes) {
        Ok(content) => Ok(ConflictFileContent {
            path: file.to_string(),
            content,
            binary: false,
            too_large: false,
        }),
        Err(_) => Ok(whole_file(true, false)),
    }
}
