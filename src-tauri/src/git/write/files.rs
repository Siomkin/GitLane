//! Worktree file writes for the in-app file editor (GL-212).
//!
//! The read-only viewer (GL-211) reads worktree text on the libgit2 side; saving
//! an edit is a working-tree mutation, so it belongs here on the write side per
//! the repo's read/write split. There is no `git` subprocess — it is a guarded,
//! atomic file write — but the same traversal/symlink guards as `repo_file_text`
//! apply, plus data-loss guards the frontend cannot enforce on its own:
//!
//! * **overwrite-only** — the file must already exist as a regular file (the
//!   Files panel only ever lists existing files); this refuses to create new
//!   files or to follow a symlink / write a directory. `.git/` is refused too, so
//!   the raw IPC surface can't be pointed at repository metadata.
//! * **size cap** — a file larger than the reader's cap can only have been read
//!   as a prefix, so its buffer can't be saved without destroying the remainder;
//!   such writes are refused in Rust independently of the frontend gate.
//! * **binary refusal** — neither the incoming content (scanned in full) nor the
//!   on-disk file may be binary.
//! * **size match** — when the caller passes the byte size it read the buffer
//!   from, a *differing* on-disk size means the file changed underneath the edit,
//!   and the write is refused. This catches size-changing external edits (and a
//!   truncated-prefix save); a same-size external edit in the read→save window is
//!   not detected — a full compare-and-swap would need a content hash and is out
//!   of scope.
//!
//! The write itself goes to a sibling temp file that is then atomically renamed
//! over the target, so a crash mid-write can't truncate the user's file, and a
//! symlink swapped in after the regular-file check is replaced rather than
//! followed. The replacement is a fresh inode, so only the file mode is carried
//! over — ownership / ACLs / xattrs / hard links are not preserved.

use std::io::Read;
use std::path::{Component, Path};

use crate::git::read::open;
use crate::git::worktree_fs::open_regular_worktree_file;

/// Same NUL-sniff window as the reader's binary detection (used only for the
/// on-disk classification; incoming content is scanned in full).
const BINARY_SNIFF_BYTES: usize = 8000;

/// Largest file the editor may write — matches the reader's `MAX_TEXT_BYTES`
/// cap. A larger file was necessarily read as a truncated prefix, so its buffer
/// is not the whole file and must never be written back.
const MAX_EDITABLE_BYTES: u64 = 2 * 1024 * 1024; // 2 MiB

/// Write `content` to the worktree file `file`, returning the new byte size.
/// `expected_size` (when given) must equal the current on-disk size or the write
/// is refused as a stale edit — see the module docs for every guard.
pub fn write_repo_file(
    repo: &str,
    file: &str,
    content: &str,
    expected_size: Option<u64>,
) -> Result<u64, String> {
    let repository = open(repo).map_err(|e| e.to_string())?;
    let workdir = repository
        .workdir()
        .ok_or_else(|| "repository has no working directory".to_string())?;
    // Never let the raw IPC path address repository metadata.
    if Path::new(file)
        .components()
        .any(|c| matches!(c, Component::Normal(name) if name.eq_ignore_ascii_case(".git")))
    {
        return Err(format!("refusing to write inside .git: {file:?}"));
    }

    let mut target =
        open_regular_worktree_file(workdir, file).map_err(|e| format!("open {file}: {e}"))?;
    // A file past the read cap can only have been loaded as a prefix — saving it
    // would destroy everything past the cap. Refuse regardless of the frontend.
    if target.len() > MAX_EDITABLE_BYTES {
        return Err(format!(
            "file is too large to edit in place ({} bytes; cap {MAX_EDITABLE_BYTES})",
            target.len()
        ));
    }

    // The remainder of a truncated read isn't in `content`; a mismatched size
    // also catches a concurrent external edit. Both would lose data on write.
    if let Some(expected) = expected_size {
        if target.len() != expected {
            return Err(format!(
                "file changed on disk since it was opened ({} bytes now, expected {expected}); reload before saving",
                target.len()
            ));
        }
    }

    // Never let the editor turn a text file binary, and never overwrite a file
    // that is already binary (the viewer wouldn't have shown editable text).
    // The whole incoming buffer is already in memory, so scan all of it.
    let bytes = content.as_bytes();
    // Cap the *incoming* payload too, not just the on-disk file — the on-disk
    // cap alone would let a bypassed frontend grow a small file past the read
    // cap (or spend unbounded IPC/disk) in one save.
    if bytes.len() as u64 > MAX_EDITABLE_BYTES {
        return Err(format!(
            "content is too large to write ({} bytes; cap {MAX_EDITABLE_BYTES})",
            bytes.len()
        ));
    }
    if bytes.contains(&0) {
        return Err("refusing to write binary content".to_string());
    }
    if on_disk_is_binary(target.reader())? {
        return Err(format!("refusing to overwrite binary file: {file:?}"));
    }

    target
        .replace_atomic(bytes)
        .map_err(|e| format!("write {file}: {e}"))?;
    Ok(bytes.len() as u64)
}

/// NUL-sniff the first bytes of the existing file (same heuristic as the reader).
fn on_disk_is_binary(handle: &mut impl Read) -> Result<bool, String> {
    let mut head = Vec::new();
    handle
        .take(BINARY_SNIFF_BYTES as u64)
        .read_to_end(&mut head)
        .map_err(|e| format!("read worktree file: {e}"))?;
    Ok(head.contains(&0))
}
