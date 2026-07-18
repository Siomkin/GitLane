//! Worktree content reads for conflicted text files.

use std::io::Read;

use crate::git::read::open;
use crate::git::types::ConflictFileContent;
use crate::git::worktree_fs::open_worktree_file;

/// The worktree copy of a conflicted text file, including git's merge markers,
/// for the in-app editor to parse. Binary files come back with empty content and
/// `binary: true` (the UI offers a whole-file choice instead of a line editor).
pub fn conflict_file(path: &str, file: &str) -> Result<ConflictFileContent, git2::Error> {
    let repo = open(path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| git2::Error::from_str("bare repository has no worktree"))?;
    // Only a genuine unmerged path may be read here — not any safe relative file.
    let conflicted = repo.index()?.conflicts()?.flatten().any(|c| {
        c.our
            .as_ref()
            .or(c.their.as_ref())
            .or(c.ancestor.as_ref())
            .map_or(false, |entry| {
                &*String::from_utf8_lossy(&entry.path) == file
            })
    });
    if !conflicted {
        return Err(git2::Error::from_str(&format!(
            "{file:?} is not a conflicted path"
        )));
    }
    // Never follow a symlink (or read a non-regular entry like a submodule
    // directory): a conflicted symlink's worktree entry can point outside the
    // repo (e.g. `link -> /etc/passwd`), and `fs::read` would follow it past the
    // traversal guard above. Report it as binary — the whole-file picker, which
    // never round-trips the worktree bytes — instead of reading the target.
    let Some(mut opened) = open_worktree_file(workdir, file)
        .map_err(|e| git2::Error::from_str(&format!("open {file}: {e}")))?
    else {
        return Ok(ConflictFileContent {
            path: file.to_string(),
            content: String::new(),
            binary: true,
        });
    };
    let mut bytes = Vec::with_capacity(opened.len().min(1024 * 1024) as usize);
    opened
        .reader()
        .read_to_end(&mut bytes)
        .map_err(|e| git2::Error::from_str(&format!("read {file}: {e}")))?;
    // Treat NUL-containing or non-UTF-8 files as binary. Lossy-decoding invalid
    // UTF-8 would replace bytes with U+FFFD and silently corrupt the file when
    // the resolved text is written back; a binary classification routes to the
    // whole-file side picker (which never round-trips the bytes through a String).
    let (binary, content) = if bytes.contains(&0) {
        (true, String::new())
    } else {
        match String::from_utf8(bytes) {
            Ok(text) => (false, text),
            Err(_) => (true, String::new()),
        }
    };
    Ok(ConflictFileContent {
        path: file.to_string(),
        content,
        binary,
    })
}
