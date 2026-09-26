//! Golden digests for the discard-all lease (dedupe-backend-helpers 1.1).
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
use super::fingerprint::{begin_tracked_digest, fingerprint_with_budget};
use super::index::capture_index;
use super::snapshot::capture_once;
use super::status::read_status;
use super::{discover_scope, IndexSnapshot, ParsedStatus, RepositoryScope, TrackedDigestContext};

const INDEX_DIGEST: &str = "b0a85e7c01345b6d5a4d44f795572a637f631610d8836ca69bea4db14ebcf84b";
const SYNTHETIC_HEADER_DIGEST: &str =
    "84f865587e63a4caedab75a33a966fe6ba517162f075b78cd8fd875d8485dffa";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn index_digest_is_pinned() {
    let repo = golden_repo("discard-index");
    let repository = git2::Repository::open(repo.path()).unwrap();
    let index = capture_index(&repository).unwrap();
    assert_eq!(hex(&index.digest), INDEX_DIGEST);
    assert_eq!(
        index.stage_zero_paths,
        ["a.txt", "c.txt", "d.txt", "e.txt"].map(|path| path.as_bytes().to_vec())
    );
}

#[test]
fn status_parse_is_pinned() {
    let repo = golden_repo("discard-status");
    let (_, scope) = discover_scope(repo.path()).unwrap();
    let status = read_status(&scope).unwrap();
    assert_eq!(status.semantic_records, golden_records());
    assert_eq!(
        status.tracked_paths,
        golden_paths().into_iter().collect::<BTreeSet<_>>()
    );
    let labels = status
        .display
        .iter()
        .map(|entry| entry.label.as_str())
        .collect::<Vec<_>>();
    assert_eq!(labels, [" M a.txt", "R  b.txt -> d.txt", "A  e.txt"]);
}

#[test]
fn budgeted_fingerprint_is_pinned() {
    let repo = golden_repo("discard-budget");
    let mut remaining = MAX_FINGERPRINT_BYTES;
    let (fingerprint, _) =
        fingerprint_with_budget(&repo.0, OsStr::new("a.txt"), &mut remaining, "ctx").unwrap();
    match fingerprint {
        WorktreeLeafFingerprint::Regular { len, mode, digest } => {
            assert_eq!((len, mode), (4, 0o100644));
            assert_eq!(digest, <[u8; 32]>::from(Sha256::digest(b"two\n")));
        }
        _ => panic!("a.txt is a regular file"),
    }
    assert_eq!(remaining, MAX_FINGERPRINT_BYTES - 4);
}

#[test]
fn tracked_header_digest_is_pinned_for_a_synthetic_scope() {
    let identity = crate::git::worktree_fs::WorktreeDirectoryIdentity {
        device: 42,
        inode: 1234,
        birth_time: Some((1_700_000_000, 5)),
    };
    let scope = RepositoryScope {
        workdir: "/repo".into(),
        gitdir: "/repo/.git".into(),
        commondir: "/repo/.git".into(),
        workdir_identity: identity,
        gitdir_identity: identity,
        commondir_identity: identity,
        is_worktree: false,
    };
    let index = IndexSnapshot {
        digest: [7u8; 32],
        stage_zero_paths: Vec::new(),
    };
    let status = ParsedStatus {
        semantic_records: vec![b" M a.txt".to_vec(), b"?? u.txt".to_vec()],
        tracked_paths: BTreeSet::from([b"a.txt".to_vec()]),
        display: Vec::new(),
    };
    let digest = begin_tracked_digest(&TrackedDigestContext {
        scope: &scope,
        head_branch: Some("main"),
        head_oid: Some("0123456789012345678901234567890123456789"),
        head_tree_oid: None,
        index: &index,
        status: &status,
    })
    .finalize();
    assert_eq!(hex(&digest), SYNTHETIC_HEADER_DIGEST);
}

/// The whole token, rebuilt from the layout spelled out here rather than from
/// the lease code. Only the scope is read back, since a temp directory's path
/// and identity differ on every run.
#[test]
fn full_token_matches_the_spelled_out_layout() {
    let repo = golden_repo("discard-token");
    let (_, scope) = discover_scope(repo.path()).unwrap();
    let (branch, head_oid, head_tree) = golden_head(&repo.0);

    let mut tracked = Sha256::new();
    hash_field(&mut tracked, b"gitlane-discard-all-tracked-v1");
    hash_os(&mut tracked, scope.workdir.as_os_str());
    hash_os(&mut tracked, scope.gitdir.as_os_str());
    hash_os(&mut tracked, scope.commondir.as_os_str());
    scope.workdir_identity.hash_into(&mut tracked);
    scope.gitdir_identity.hash_into(&mut tracked);
    scope.commondir_identity.hash_into(&mut tracked);
    tracked.update([u8::from(scope.is_worktree)]);
    hash_optional(&mut tracked, Some(&branch));
    hash_optional(&mut tracked, Some(&head_oid));
    hash_optional(&mut tracked, Some(&head_tree));
    hash_field(&mut tracked, &unhex(INDEX_DIGEST));
    let records = golden_records();
    tracked.update((records.len() as u64).to_le_bytes());
    for record in &records {
        hash_field(&mut tracked, record);
    }
    let paths = golden_paths();
    tracked.update((paths.len() as u64).to_le_bytes());
    for path in &paths {
        hash_field(&mut tracked, path);
        hash_golden_leaf(&mut tracked, path);
    }
    let tracked: [u8; 32] = tracked.finalize().into();

    let mut full = Sha256::new();
    hash_field(&mut full, b"gitlane-discard-all-v1");
    hash_field(&mut full, &tracked);
    hash_field(&mut full, &tracked);
    full.update(0u64.to_le_bytes());
    full.update(0u64.to_le_bytes());
    let expected = format!("v1:{}", URL_SAFE_NO_PAD.encode(full.finalize()));

    let snapshot = capture_once(repo.path()).unwrap();
    assert_eq!(snapshot.expected_state, expected);
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
        .collect()
}
