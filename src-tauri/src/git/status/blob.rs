//! Raw blob / working-tree byte reads for inline previews (images today).
//!
//! Binary deltas carry no text diff, so the review surface needs the actual
//! bytes to show an image. This returns them base64-encoded for one of the two
//! sources a diff can reference: a committed/staged blob (by oid) or the
//! working-tree file (by path — the only side libgit2 leaves without a blob oid).

use base64::Engine;
use git2::Oid;
use std::io::Read;

use crate::git::read::open;
use crate::git::types::BinaryBlob;
use crate::git::worktree_fs::open_regular_worktree_file;

/// Hard cap on bytes returned inline as base64 for a preview. Beyond this the
/// command returns the size only (`truncated: true`) and the UI shows a size
/// card instead of pushing a multi-megabyte data URL through the webview.
const MAX_PREVIEW_BYTES: u64 = 8 * 1024 * 1024; // 8 MiB

/// Read at most `cap` bytes, or `None` when there are more. The metadata size
/// checked before this is only a hint: a repository-controlled file can grow
/// between that check and the read, so the read itself is bounded too.
pub(super) fn read_at_most(reader: impl Read, cap: u64) -> std::io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    reader.take(cap + 1).read_to_end(&mut bytes)?;
    Ok((bytes.len() as u64 <= cap).then_some(bytes))
}

/// Read one blob's bytes for a preview. Prefers an explicit `oid` (committed or
/// staged content); when none is given, reads the working-tree `file` by its
/// repo-relative path. Returns `base64: None` + `truncated: true` when the
/// content exceeds `max_bytes` (defaulting to [`MAX_PREVIEW_BYTES`]).
pub fn read_binary_blob(
    path: &str,
    oid: Option<&str>,
    file: Option<&str>,
    max_bytes: Option<u64>,
) -> Result<BinaryBlob, git2::Error> {
    let repo = open(path)?;
    // The cap is a hard ceiling: a client-supplied `max_bytes` may only *lower*
    // it (the tests use this to force truncation), never raise it past the
    // server's own limit.
    let cap = max_bytes.map_or(MAX_PREVIEW_BYTES, |m| m.min(MAX_PREVIEW_BYTES));

    // Resolve the byte size *before* loading any content, so an oversized blob is
    // rejected without allocating it: the ODB header carries a blob's size, and
    // `metadata` a working-tree file's.
    let bytes: Vec<u8> = match oid.filter(|s| !s.is_empty()) {
        Some(oid) => {
            let oid = Oid::from_str(oid)?;
            let (size, _kind) = repo.odb()?.read_header(oid)?;
            if size as u64 > cap {
                return Ok(BinaryBlob {
                    base64: None,
                    size: size as u64,
                    truncated: true,
                });
            }
            repo.find_blob(oid)?.content().to_vec()
        }
        None => {
            let file = file.ok_or_else(|| {
                git2::Error::from_str("read_binary_blob needs a blob oid or a file path")
            })?;
            let workdir = repo
                .workdir()
                .ok_or_else(|| git2::Error::from_str("repository has no working directory"))?;
            let mut opened = open_regular_worktree_file(workdir, file)
                .map_err(|e| git2::Error::from_str(&format!("open {file}: {e}")))?;
            let len = opened.len();
            let read = if len > cap {
                None
            } else {
                read_at_most(opened.reader(), cap)
                    .map_err(|e| git2::Error::from_str(&format!("read {file}: {e}")))?
            };
            let Some(bytes) = read else {
                return Ok(BinaryBlob {
                    base64: None,
                    size: len.max(cap + 1),
                    truncated: true,
                });
            };
            bytes
        }
    };

    let size = bytes.len() as u64;
    let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(BinaryBlob {
        base64: Some(base64),
        size,
        truncated: false,
    })
}

#[cfg(test)]
mod tests {
    use super::read_at_most;

    /// The read is bounded even when the source never ends, as a file that
    /// keeps growing after its size was checked would.
    #[test]
    fn a_read_past_the_cap_stops_at_the_cap() {
        assert_eq!(read_at_most(std::io::repeat(b'x'), 8).unwrap(), None);
        assert_eq!(
            read_at_most(&b"12345678"[..], 8).unwrap().as_deref(),
            Some(&b"12345678"[..])
        );
    }
}
