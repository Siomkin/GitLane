//! The `git status --porcelain=v1 -z` read both leases hash.

use super::{run_scoped_git_stdout_raw, LeaseError, RepositoryScope};

/// One porcelain record: the two-byte code, its path, and a rename or copy's
/// original path.
pub(in crate::git::write) struct StatusRecord {
    pub(in crate::git::write) code: [u8; 2],
    pub(in crate::git::write) path: Vec<u8>,
    pub(in crate::git::write) orig: Option<Vec<u8>>,
}

impl StatusRecord {
    /// The record as the leases hash it: `XY path`, then NUL and the original
    /// path for a rename or copy.
    pub(in crate::git::write) fn semantic(&self) -> Vec<u8> {
        let mut semantic = Vec::with_capacity(3 + self.path.len());
        semantic.extend_from_slice(&self.code);
        semantic.push(b' ');
        semantic.extend_from_slice(&self.path);
        if let Some(orig) = &self.orig {
            semantic.push(0);
            semantic.extend_from_slice(orig);
        }
        semantic
    }
}

fn malformed(what: &str) -> LeaseError {
    LeaseError::Worded(format!("Git returned a malformed {what}status record."))
}

/// Read and split the worktree's porcelain-v1 status, untracked files included
/// and fsmonitor bypassed so the answer comes from the filesystem itself.
pub(in crate::git::write) fn read_porcelain_z(
    scope: &RepositoryScope,
) -> Result<Vec<StatusRecord>, LeaseError> {
    let raw = run_scoped_git_stdout_raw(
        scope,
        &[
            "-c",
            "core.fsmonitor=false",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
    )?;
    let mut records = Vec::new();
    let mut cursor = 0usize;
    let next_field = |cursor: &mut usize, what: &str| {
        let end = raw[*cursor..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|offset| *cursor + offset)
            .ok_or_else(|| malformed(what))?;
        let field = &raw[*cursor..end];
        *cursor = end + 1;
        Ok::<_, LeaseError>(field)
    };
    while cursor < raw.len() {
        let record = next_field(&mut cursor, "")?;
        if record.is_empty() {
            continue;
        }
        if record.len() < 4 || record[2] != b' ' {
            return Err(malformed(""));
        }
        let code = [record[0], record[1]];
        let path = record[3..].to_vec();
        let orig = if code.iter().any(|byte| matches!(*byte, b'R' | b'C')) {
            Some(next_field(&mut cursor, "rename ")?.to_vec())
        } else {
            None
        };
        records.push(StatusRecord { code, path, orig });
    }
    Ok(records)
}
