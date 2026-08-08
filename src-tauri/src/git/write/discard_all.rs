//! Exact-state whole-worktree discard.
//!
//! The confirmation captures the repository identity, HEAD, semantic index,
//! tracked changes, and the exact removable untracked leaves. The write
//! re-captures that lease before mutating and never re-enumerates a wider clean
//! set. Tracked state is checked again after cleanup before the captured tree
//! is restored into the index and worktree without resolving or moving HEAD.
//!
//! The operation is split across `discard_all/` (GL-341): `snapshot` captures
//! and re-validates the lease, `fingerprint` digests the tracked side of it,
//! `status` and `nested` are the reads it is built from, `cleanup` removes the
//! captured untracked leaves, and `hooks` holds the test seams. The lease's data
//! types stay here in the facade — every submodule reads them, and a parent's
//! private items are visible to its children, so no field needed widening.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{OsStr, OsString};
use std::sync::Arc;

use git2::Repository;
use sha2::Sha256;

#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;

use crate::git::types::DiscardAllPreview;
use crate::git::worktree_fs::{WorktreeLeafFingerprint, WorktreeLeafObservation};

use super::cli::run_git_scoped_os;
use super::recovery::push_list;
use super::state_lease::{self, path_label, scoped_git_args, LeaseError, RepositoryScope};
mod cleanup;
mod fingerprint;
mod hooks;
mod nested;
mod snapshot;
mod status;

use cleanup::{cleanup_paths, cleanup_set};
use hooks::{
    run_after_cleanup_test_hook, run_after_tracked_scope_validation_test_hook,
    run_after_validation_test_hook, run_before_tracked_reset_test_hook,
};
use snapshot::{
    capture_current_tracked, capture_current_tracked_from_snapshot, capture_stable,
    validate_head_lease, validate_observations,
};

// The write suite drives this operation's test hooks through the module path
// (`git::write::discard_all::set_discard_all_*`), so re-export them here rather
// than have the suite reach into a private submodule.
#[cfg(test)]
pub(crate) use hooks::{
    set_discard_all_after_cleanup_test_hook, set_discard_all_after_first_clean_batch_test_hook,
    set_discard_all_after_tracked_scope_validation_test_hook,
    set_discard_all_after_validation_test_hook, set_discard_all_before_tracked_reset_test_hook,
    set_discard_all_capture_test_hook, start_discard_all_fingerprint_byte_count,
    take_discard_all_fingerprint_byte_count,
};

// The lease's data types stay in the facade rather than moving into one of the
// submodules: every submodule reads them, and a parent module's private items
// are visible to its children — so keeping them here is what lets the split
// leave every field declaration untouched.

/// Render a shared-primitive failure in this operation's own words.
pub(super) fn describe_lease_error(error: LeaseError) -> String {
    match error {
        LeaseError::WorkdirNotUtf8 => {
            "Cannot run Discard all from a worktree path that is not valid UTF-8.".to_string()
        }
        LeaseError::OpenRepository(error) => format!("Could not inspect the repository before discarding: {error}"),
        LeaseError::BareRepository => "Cannot discard changes in a bare repository.".to_string(),
        LeaseError::NonUtf8GitPath => "Discard all cannot safely represent a non-UTF-8 Git path on this platform.".to_string(),
        LeaseError::ReplaceRefsActive => "Discard all is unavailable while Git replacement refs are active. Remove the replacement refs or use the terminal.".to_string(),
        LeaseError::InspectHead(error) => format!("Could not inspect HEAD before discarding: {error}"),
        LeaseError::ResolveHead(error) => format!("Could not resolve HEAD before discarding: {error}"),
        LeaseError::NonFileWorktreePath { label, kind, mode } => {
            format!("Refusing to discard non-file worktree path {label} (type {kind}, mode {mode:o}). Move the directory or nested repository aside and try again.")
        }
        LeaseError::Worded(text) => text,
    }
}

fn discover_scope(repo: &str) -> Result<(Repository, RepositoryScope), String> {
    state_lease::discover_scope(repo).map_err(describe_lease_error)
}

fn git_path(bytes: &[u8]) -> Result<OsString, String> {
    state_lease::git_path(bytes).map_err(describe_lease_error)
}

fn head_state(repository: &Repository) -> Result<(Option<String>, Option<String>), String> {
    state_lease::head_state(repository).map_err(describe_lease_error)
}

fn ensure_no_replace_refs(scope: &RepositoryScope) -> Result<(), String> {
    state_lease::ensure_no_replace_refs(scope).map_err(describe_lease_error)
}

fn fingerprint_into(
    state: &mut Sha256,
    fingerprint: &WorktreeLeafFingerprint,
    label: &str,
) -> Result<(), String> {
    state_lease::fingerprint_into(state, fingerprint, label).map_err(describe_lease_error)
}

fn command_repo(scope: &RepositoryScope) -> Result<&str, String> {
    state_lease::command_repo(scope).map_err(describe_lease_error)
}

fn run_scoped_git_stdout_raw(scope: &RepositoryScope, args: &[&str]) -> Result<Vec<u8>, String> {
    state_lease::run_scoped_git_stdout_raw(scope, args).map_err(describe_lease_error)
}

fn effective_head_tree_oid(
    scope: &RepositoryScope,
    head_oid: Option<&str>,
) -> Result<Option<String>, String> {
    state_lease::effective_head_tree_oid(scope, head_oid).map_err(describe_lease_error)
}

#[cfg(not(windows))]
const CLEAN_PATH_BATCH_MAX_BYTES: usize = 64 * 1024;
#[cfg(windows)]
const CLEAN_PATH_BATCH_MAX_BYTES: usize = 24 * 1024;
const CLEAN_PATH_BATCH_MAX_ARGS: usize = 500;
const STALE_MESSAGE: &str =
    "The working tree changed after this confirmation opened. Preview Discard all again.";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
enum CleanupKind {
    Ordinary,
}

struct CleanupLeaf {
    path: OsString,
    kind: CleanupKind,
    observation: Arc<WorktreeLeafObservation>,
}

struct TrackedLeaf {
    path: OsString,
    observation: Arc<WorktreeLeafObservation>,
}

struct TrackedCapture {
    digest: [u8; 32],
    observations: Vec<TrackedLeaf>,
    fingerprints: BTreeMap<Vec<u8>, (WorktreeLeafFingerprint, Arc<WorktreeLeafObservation>)>,
}

struct DiscardAllSnapshot {
    expected_state: String,
    tracked_state: [u8; 32],
    post_cleanup_tracked_state: [u8; 32],
    scope: RepositoryScope,
    expected_head_branch: Option<String>,
    expected_head_oid: Option<String>,
    expected_head_tree_oid: Option<String>,
    cleanup: Vec<CleanupLeaf>,
    tracked: Vec<TrackedLeaf>,
    tracked_fingerprints:
        BTreeMap<Vec<u8>, (WorktreeLeafFingerprint, Arc<WorktreeLeafObservation>)>,
    preserved_nested_repos: Vec<OsString>,
    display_status: Vec<String>,
}

struct ParsedStatus {
    semantic_records: Vec<Vec<u8>>,
    tracked_paths: BTreeSet<Vec<u8>>,
    display: Vec<StatusDisplay>,
}

struct StatusDisplay {
    label: String,
    paths: Vec<Vec<u8>>,
}

struct IndexSnapshot {
    digest: [u8; 32],
    stage_zero_paths: Vec<Vec<u8>>,
}

struct TrackedDigestContext<'a> {
    scope: &'a RepositoryScope,
    head_branch: Option<&'a str>,
    head_oid: Option<&'a str>,
    head_tree_oid: Option<&'a str>,
    index: &'a IndexSnapshot,
    status: &'a ParsedStatus,
}

#[cfg(unix)]
fn git_bytes(value: &OsStr) -> Result<Vec<u8>, String> {
    Ok(value.as_bytes().to_vec())
}

#[cfg(not(unix))]
fn git_bytes(value: &OsStr) -> Result<Vec<u8>, String> {
    value
        .to_str()
        .map(|value| value.as_bytes().to_vec())
        .ok_or_else(|| "Discard all cannot safely represent a non-UTF-8 Git path.".to_string())
}

fn run_scoped_git(scope: &RepositoryScope, args: &[&str]) -> Result<String, String> {
    run_git_scoped_os(
        command_repo(scope)?,
        scope.commondir.as_os_str(),
        &scoped_git_args(scope, args),
    )
}

fn run_scoped_git_paths(
    scope: &RepositoryScope,
    prefix_args: &[&str],
    path_args: &[OsString],
) -> Result<String, String> {
    let mut args = scoped_git_args(scope, prefix_args);
    args.extend(path_args.iter().cloned());
    run_git_scoped_os(command_repo(scope)?, scope.commondir.as_os_str(), &args)
}

fn validate_repository_scope(expected: &RepositoryScope) -> Result<(), String> {
    let (_, current) = discover_scope(command_repo(expected)?)?;
    if current != *expected {
        return Err(STALE_MESSAGE.to_string());
    }
    Ok(())
}

fn discard_message(snapshot: &DiscardAllSnapshot) -> String {
    if snapshot.preserved_nested_repos.is_empty() {
        return "Discarded all changes".to_string();
    }
    format!(
        "Discarded tracked and removable untracked changes; preserved nested Git repositories: {}",
        snapshot
            .preserved_nested_repos
            .iter()
            .map(|path| path_label(path))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

pub fn preview_discard_all(repo: &str) -> Result<DiscardAllPreview, String> {
    let snapshot = capture_stable(repo)?;
    let mut details = Vec::new();
    if snapshot.display_status.is_empty() {
        details.push(if snapshot.preserved_nested_repos.is_empty() {
            "The working tree is already clean.".to_string()
        } else {
            "No removable working-tree changes were found outside the protected nested repositories."
                .to_string()
        });
    } else {
        let mut shown = snapshot
            .display_status
            .iter()
            .take(16)
            .cloned()
            .collect::<Vec<_>>();
        if snapshot.display_status.len() > shown.len() {
            shown.push(format!(
                "… and {} more",
                snapshot.display_status.len() - shown.len()
            ));
        }
        push_list(&mut details, "Files that will be reset or removed", &shown);
    }
    if !snapshot.preserved_nested_repos.is_empty() {
        let preserved = snapshot
            .preserved_nested_repos
            .iter()
            .map(|path| path_label(path))
            .collect::<Vec<_>>();
        push_list(
            &mut details,
            "Nested Git repositories that will be preserved",
            &preserved,
        );
    }
    let mut warnings = vec![
        "Tracked edits may be recoverable only if they were previously committed or stashed."
            .to_string(),
        "Untracked files Git can remove are not recoverable from the reflog; empty directories are preserved."
            .to_string(),
    ];
    if !snapshot.preserved_nested_repos.is_empty() {
        warnings.push(
            "Nested Git repositories are protected and will remain after other changes are discarded."
                .to_string(),
        );
    }
    Ok(DiscardAllPreview {
        summary: "Discard every staged, unstaged, and removable untracked working-tree change"
            .to_string(),
        details,
        warnings,
        expected_state: snapshot.expected_state,
        expected_head_branch: snapshot.expected_head_branch,
        expected_head_oid: snapshot.expected_head_oid,
    })
}

pub fn discard_all(
    repo: &str,
    expected_state: &str,
    expected_head_branch: Option<&str>,
    expected_head_oid: Option<&str>,
) -> Result<String, String> {
    let _index_guard = super::index_lock::lock_index_writes(repo)?;
    let snapshot = capture_stable(repo).map_err(|error| format!("{STALE_MESSAGE} {error}"))?;
    if snapshot.expected_state != expected_state
        || snapshot.expected_head_branch.as_deref() != expected_head_branch
        || snapshot.expected_head_oid.as_deref() != expected_head_oid
    {
        return Err(STALE_MESSAGE.to_string());
    }
    validate_observations(&snapshot)?;
    run_after_validation_test_hook();
    let current_tracked = capture_current_tracked_from_snapshot(&snapshot)?;
    if current_tracked != snapshot.tracked_state {
        return Err(STALE_MESSAGE.to_string());
    }
    validate_observations(&snapshot)?;

    let ordinary_removed = cleanup_paths(
        &snapshot.scope,
        snapshot
            .cleanup
            .iter()
            .filter(|leaf| leaf.kind == CleanupKind::Ordinary),
        false,
    )?;
    run_after_cleanup_test_hook();

    let expected_tree_oid = snapshot
        .expected_head_tree_oid
        .as_deref()
        .ok_or_else(|| STALE_MESSAGE.to_string())?;
    let normalized = cleanup_set(&snapshot, CleanupKind::Ordinary)?;
    let tracked_after_cleanup = capture_current_tracked(&snapshot.scope, &normalized).map_err(
        |error| {
            if ordinary_removed {
                format!(
                    "Approved untracked cleanup completed, but tracked state could not be rechecked; tracked edits were preserved: {error}"
                )
            } else {
                error
            }
        },
    )?;
    if tracked_after_cleanup != snapshot.post_cleanup_tracked_state {
        return Err(if ordinary_removed {
            "Approved untracked cleanup completed, but tracked changes changed before reset; the tracked edits were preserved. Refresh and preview again."
                .to_string()
        } else {
            STALE_MESSAGE.to_string()
        });
    }
    run_before_tracked_reset_test_hook();
    validate_head_lease(&snapshot).map_err(|error| {
        if ordinary_removed {
            format!(
                "Approved untracked cleanup completed, but the repository scope or HEAD changed before reset; tracked edits were preserved: {error}"
            )
        } else {
            error
        }
    })?;
    run_after_tracked_scope_validation_test_hook();
    run_scoped_git(
        &snapshot.scope,
        &[
            "--no-replace-objects",
            "-c",
            "submodule.recurse=false",
            "read-tree",
            "--reset",
            "-u",
            "--no-recurse-submodules",
            expected_tree_oid,
        ],
    )
    .map_err(|error| {
        if ordinary_removed {
            format!(
                "Approved untracked cleanup completed, but tracked changes could not be reset: {error}"
            )
        } else {
            error
        }
    })?;
    validate_head_lease(&snapshot).map_err(|error| {
        format!(
            "Approved tracked changes were reset to the previewed commit, but the repository scope or HEAD changed during reset: {error}"
        )
    })?;
    Ok(discard_message(&snapshot))
}

#[cfg(test)]
mod tests {
    use super::fingerprint::begin_tracked_digest;
    use super::{IndexSnapshot, ParsedStatus, RepositoryScope, TrackedDigestContext};
    use crate::git::worktree_fs::WorktreeDirectoryIdentity;
    use sha2::Digest;
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    fn scope_with_birth_time(birth_time: Option<(i64, u32)>) -> RepositoryScope {
        let identity = WorktreeDirectoryIdentity {
            device: 42,
            inode: 1234,
            birth_time,
        };
        RepositoryScope {
            workdir: PathBuf::from("/repo"),
            gitdir: PathBuf::from("/repo/.git"),
            commondir: PathBuf::from("/repo/.git"),
            workdir_identity: identity,
            gitdir_identity: identity,
            commondir_identity: identity,
            is_worktree: true,
        }
    }

    fn digest_for(scope: &RepositoryScope) -> [u8; 32] {
        let index = IndexSnapshot {
            digest: [7u8; 32],
            stage_zero_paths: vec![b"a.txt".to_vec()],
        };
        let status = ParsedStatus {
            semantic_records: vec![b" M a.txt".to_vec()],
            tracked_paths: BTreeSet::from([b"a.txt".to_vec()]),
            display: Vec::new(),
        };
        begin_tracked_digest(&TrackedDigestContext {
            scope,
            head_branch: Some("main"),
            head_oid: Some("0123456789012345678901234567890123456789"),
            head_tree_oid: Some("9876543210987654321098765432109876543210"),
            index: &index,
            status: &status,
        })
        .finalize()
        .into()
    }

    /// Discard All destroys uncommitted work, so its confirmation must not be
    /// satisfiable by a directory that merely inherited the previewed one's
    /// inode. Only `expected_state` crosses preview to execution, so the
    /// creation time has to reach the digest — this hashed device and inode by
    /// hand until it was routed through the shared encoding.
    #[test]
    fn scope_digest_separates_incarnations_sharing_a_device_and_inode() {
        let previewed = scope_with_birth_time(Some((1_700_000_000, 0)));
        let replacement = scope_with_birth_time(Some((1_700_000_001, 0)));

        assert_ne!(
            digest_for(&previewed),
            digest_for(&replacement),
            "a replacement handed the previewed inode must not reproduce its token"
        );
    }

    #[test]
    fn scope_digest_is_stable_for_an_unchanged_scope() {
        let scope = scope_with_birth_time(Some((1_700_000_000, 0)));

        assert_eq!(
            digest_for(&scope),
            digest_for(&scope),
            "an unchanged scope must keep its token, or every confirm goes stale"
        );
    }

    #[test]
    fn scope_digest_separates_a_missing_creation_time_from_a_present_one() {
        assert_ne!(
            digest_for(&scope_with_birth_time(None)),
            digest_for(&scope_with_birth_time(Some((1_700_000_000, 0)))),
        );
    }
}
