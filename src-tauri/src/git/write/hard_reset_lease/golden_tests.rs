//! Golden digests for the hard-reset lease (dedupe-backend-helpers 1.1).
//!
//! Pinned before the lease primitives moved into `state_lease`, and required
//! unchanged after: a confirmation token minted by one build must be the token
//! the next build re-captures, or every open confirm goes stale.

use std::collections::BTreeSet;
use std::ffi::OsStr;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};

use crate::git::worktree_fs::WorktreeLeafFingerprint;

use super::super::state_lease::golden_fixture::{
    golden_head, golden_paths, golden_records, golden_repo, hash_golden_leaf, hash_optional,
};
use super::super::state_lease::{hash_field, hash_os, MAX_FINGERPRINT_BYTES};
use super::capture::capture;
use super::fingerprint::{
    capture_index_digest, effective_tree_oid_no_replace, fingerprint_with_budget, read_status,
};
use super::scope::discover_scope;

const INDEX_DIGEST: &str = "6aecbb7d6ac95c5b7cbf2fe2a9658f65b2a725dd9c474c468c13655ce0543dc6";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn index_digest_is_pinned() {
    let repo = golden_repo("reset-index");
    let repository = git2::Repository::open(repo.path()).unwrap();
    assert_eq!(
        hex(&capture_index_digest(&repository).unwrap()),
        INDEX_DIGEST
    );
}

#[test]
fn status_parse_is_pinned() {
    let repo = golden_repo("reset-status");
    let (_, scope) = discover_scope(repo.path()).unwrap();
    let status = read_status(&scope).unwrap();
    assert_eq!(status.semantic_records, golden_records());
    assert_eq!(
        status.dirty_paths,
        golden_paths().into_iter().collect::<BTreeSet<_>>()
    );
}

#[test]
fn budgeted_fingerprint_is_pinned() {
    let repo = golden_repo("reset-budget");
    let mut remaining = MAX_FINGERPRINT_BYTES;
    let (fingerprint, _) =
        fingerprint_with_budget(&repo.0, OsStr::new("d.txt"), &mut remaining).unwrap();
    match fingerprint {
        WorktreeLeafFingerprint::Regular { len, mode, digest } => {
            assert_eq!((len, mode), (4, 0o100644));
            assert_eq!(digest, <[u8; 32]>::from(Sha256::digest(b"bee\n")));
        }
        _ => panic!("d.txt is a regular file"),
    }
    assert_eq!(remaining, MAX_FINGERPRINT_BYTES - 4);
}

#[test]
fn target_tree_resolves_to_the_commit_tree() {
    let repo = golden_repo("reset-tree");
    let (_, scope) = discover_scope(repo.path()).unwrap();
    let (_, head_oid, head_tree) = golden_head(&repo.0);
    assert_eq!(
        effective_tree_oid_no_replace(&scope, &head_oid).unwrap(),
        head_tree
    );
}

/// The whole token, rebuilt from the layout spelled out here rather than from
/// the lease code. Only the scope is read back, since a temp directory's path
/// and identity differ on every run.
#[test]
fn full_token_matches_the_spelled_out_layout() {
    let repo = golden_repo("reset-token");
    let (_, scope) = discover_scope(repo.path()).unwrap();
    let (branch, head_oid, head_tree) = golden_head(&repo.0);

    let mut full = Sha256::new();
    hash_field(&mut full, b"gitlane-hard-reset-v2");
    hash_os(&mut full, scope.workdir.as_os_str());
    hash_os(&mut full, scope.gitdir.as_os_str());
    hash_os(&mut full, scope.commondir.as_os_str());
    scope.workdir_identity.hash_into(&mut full);
    scope.gitdir_identity.hash_into(&mut full);
    scope.commondir_identity.hash_into(&mut full);
    full.update([u8::from(scope.is_worktree)]);
    full.update([0]); // core.ignorecase=false
    hash_optional(&mut full, Some(&branch));
    hash_optional(&mut full, Some(&head_oid));
    hash_optional(&mut full, Some(&head_tree));
    hash_field(&mut full, head_tree.as_bytes()); // target = HEAD
    full.update(unhex(INDEX_DIGEST));
    let records = golden_records();
    full.update((records.len() as u64).to_le_bytes());
    for record in &records {
        hash_field(&mut full, record);
    }
    full.update(0u64.to_le_bytes()); // no obstructions
    let paths = golden_paths();
    full.update((paths.len() as u64).to_le_bytes());
    for path in &paths {
        hash_field(&mut full, path);
        hash_golden_leaf(&mut full, path);
    }
    hash_field(&mut full, head_oid.as_bytes());
    let expected = format!("v2:{}", URL_SAFE_NO_PAD.encode(full.finalize()));

    let (state, _, _) = capture(repo.path(), &head_oid).unwrap();
    assert_eq!(state, expected);
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
        .collect()
}
