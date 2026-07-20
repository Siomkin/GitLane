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
//! * **exact-state lease** — both the byte size and opaque SHA-256 state returned
//!   by the lossless viewer read must still match a complete bounded read of the
//!   held target. Same-size external edits are therefore refused too.
//!
//! The write itself goes to a sibling temp file that is then atomically renamed
//! over the target, so a crash mid-write can't truncate the user's file, and a
//! symlink swapped in after the regular-file check is replaced rather than
//! followed. The replacement is a fresh inode, so only the file mode is carried
//! over — ownership / ACLs / xattrs / hard links are not preserved.

use std::path::{Component, Path};

use crate::git::file_state;
use crate::git::read::open;
use crate::git::types::RepoFileWriteResult;
use crate::git::worktree_fs::open_regular_worktree_file;

/// Largest file the editor may write — matches the reader's `MAX_TEXT_BYTES`
/// cap. A larger file was necessarily read as a truncated prefix, so its buffer
/// is not the whole file and must never be written back.
const MAX_EDITABLE_BYTES: u64 = 2 * 1024 * 1024; // 2 MiB

#[cfg(test)]
std::thread_local! {
    static BEFORE_REPLACE_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

/// Deterministically replace a fixture after its content lease was verified but
/// before the final pathname-identity check.
#[cfg(test)]
pub(crate) fn set_before_replace_test_hook(hook: impl FnOnce() + 'static) {
    BEFORE_REPLACE_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
fn run_before_replace_test_hook() {
    BEFORE_REPLACE_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_before_replace_test_hook() {}

/// Write `content` to the worktree file `file`, returning its next state lease.
/// Both expected values are mandatory and must describe the same complete bytes
/// currently held at `file`; see the module docs for every guard.
pub fn write_repo_file(
    repo: &str,
    file: &str,
    content: &str,
    expected_size: u64,
    expected_state: &str,
) -> Result<RepoFileWriteResult, String> {
    if expected_state.is_empty() {
        return Err("missing file state token; reload before saving".to_string());
    }
    if !file_state::is_well_formed(expected_state) {
        return Err("invalid file state token; reload before saving".to_string());
    }

    let repository = open(repo).map_err(|e| e.to_string())?;
    let workdir = repository
        .workdir()
        .ok_or_else(|| "repository has no working directory".to_string())?;
    // Resolve the ownership scope exactly once before any mutation. Token
    // generation after rename is then infallible and cannot mix a new root
    // resolution with the pre-write leaf snapshot.
    let state_scope = file_state::FileStateScope::capture(&repository, workdir, file)?;
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

    let snapshot = target
        .read_prefix_coherent(MAX_EDITABLE_BYTES as usize)
        .map_err(|e| format!("read {file} before saving: {e}"))?;
    if snapshot.truncated {
        return Err(format!(
            "file is too large to edit in place ({} bytes; cap {MAX_EDITABLE_BYTES})",
            snapshot.size
        ));
    }
    let actual_state = file_state::expected_state(&state_scope, snapshot.identity, &snapshot.bytes);
    if snapshot.size != expected_size {
        return Err(format!(
            "file changed on disk since it was opened ({} bytes now, expected {expected_size}); reload before saving",
            snapshot.size
        ));
    }
    if actual_state != expected_state {
        return Err(
            "file changed on disk since it was opened (its contents or file identity no longer match); reload before saving"
                .to_string(),
        );
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
    if snapshot.bytes.contains(&0) {
        return Err(format!("refusing to overwrite binary file: {file:?}"));
    }

    run_before_replace_test_hook();
    let replacement_identity = target
        .replace_atomic_if_current(bytes)
        .map_err(|e| format!("write {file}: {e}"))?;
    Ok(RepoFileWriteResult {
        size: bytes.len() as u64,
        expected_state: file_state::expected_state(&state_scope, replacement_identity, bytes),
    })
}
