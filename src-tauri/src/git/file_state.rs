//! Opaque compare-and-swap tokens for the repository file editor.
//!
//! The token commits to the discovered repository and worktree, relative path,
//! concrete leaf identity/mode/length, and exactly the bytes returned by
//! `repo_file_text`. That makes same-size writes, atomic inode replacements, and
//! cross-worktree token replay stale. The domain string prevents this digest
//! from being confused with another SHA-256 lease, while the prefix makes future
//! formats reject old callers instead of silently weakening the guard.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};
use std::path::Path;

use crate::git::worktree_fs::WorktreeFileIdentity;
use crate::git::{hash_field, os_bytes};

const TOKEN_PREFIX: &str = "repo-file:v1:";
const HASH_DOMAIN: &[u8] = b"GitLane repository file edit state\0v1\0";

pub(crate) struct FileStateScope {
    repository_path: Vec<u8>,
    workdir_path: Vec<u8>,
    file: Vec<u8>,
}

impl FileStateScope {
    pub(crate) fn capture(
        repository: &git2::Repository,
        workdir: &Path,
        file: &str,
    ) -> Result<Self, String> {
        let repository_path = std::fs::canonicalize(repository.path())
            .map_err(|error| format!("resolve repository identity: {error}"))?;
        let workdir_path = std::fs::canonicalize(workdir)
            .map_err(|error| format!("resolve worktree identity: {error}"))?;
        Ok(Self {
            repository_path: os_bytes(repository_path.as_os_str()),
            workdir_path: os_bytes(workdir_path.as_os_str()),
            file: file.as_bytes().to_vec(),
        })
    }
}

pub(crate) fn expected_state(
    scope: &FileStateScope,
    identity: WorktreeFileIdentity,
    bytes: &[u8],
) -> String {
    let mut state = Sha256::new();
    state.update(HASH_DOMAIN);
    hash_field(&mut state, &scope.repository_path);
    hash_field(&mut state, &scope.workdir_path);
    hash_field(&mut state, &scope.file);
    state.update(identity.device.to_le_bytes());
    state.update(identity.inode.to_le_bytes());
    state.update(identity.mode.to_le_bytes());
    state.update(identity.len.to_le_bytes());
    hash_field(&mut state, bytes);
    format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(state.finalize()))
}

pub(crate) fn is_well_formed(state: &str) -> bool {
    let Some(encoded) = state.strip_prefix(TOKEN_PREFIX) else {
        return false;
    };
    URL_SAFE_NO_PAD
        .decode(encoded)
        .is_ok_and(|digest| digest.len() == 32)
}

#[cfg(test)]
mod tests {
    use super::is_well_formed;

    #[test]
    fn token_format_is_versioned_and_strict() {
        assert!(is_well_formed(
            "repo-file:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        ));
        assert!(!is_well_formed(""));
        assert!(!is_well_formed("v1:not-a-repo-file-token"));
    }
}
