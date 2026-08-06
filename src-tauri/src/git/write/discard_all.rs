//! Exact-state whole-worktree discard.
//!
//! The confirmation captures the repository identity, HEAD, semantic index,
//! tracked changes, and the exact removable untracked leaves. The write
//! re-captures that lease before mutating and never re-enumerates a wider clean
//! set. Tracked state is checked again after cleanup before the captured tree
//! is restored into the index and worktree without resolving or moving HEAD.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::sync::Arc;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use git2::{IndexEntryExtendedFlag, IndexEntryFlag, Repository};
use sha2::{Digest, Sha256};

#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;

use crate::git::types::DiscardAllPreview;
use crate::git::worktree_fs::{
    fingerprint_worktree_leaf_path_bounded, validate_worktree_leaf_observation_path,
    worktree_leaf_is_missing_path, worktree_regular_leaf_size_path, WorktreeLeafFingerprint,
    WorktreeLeafObservation,
};

use super::cli::run_git_scoped_os;
use super::recovery::push_list;
use super::state_lease::{
    self, hash_field, hash_os, os_bytes, path_label, scoped_git_args, LeaseError, RepositoryScope,
    MAX_FINGERPRINT_BYTES,
};

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

#[cfg(test)]
std::thread_local! {
    static DISCARD_ALL_CAPTURE_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static DISCARD_ALL_AFTER_VALIDATION_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static DISCARD_ALL_AFTER_CLEANUP_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static DISCARD_ALL_AFTER_FIRST_CLEAN_BATCH_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static DISCARD_ALL_BEFORE_TRACKED_RESET_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static DISCARD_ALL_AFTER_TRACKED_SCOPE_VALIDATION_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    static DISCARD_ALL_FINGERPRINT_BYTES_TEST: std::cell::Cell<Option<u64>> =
        const { std::cell::Cell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_discard_all_capture_test_hook(hook: impl FnOnce() + 'static) {
    DISCARD_ALL_CAPTURE_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(crate) fn set_discard_all_after_validation_test_hook(hook: impl FnOnce() + 'static) {
    DISCARD_ALL_AFTER_VALIDATION_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(crate) fn set_discard_all_after_cleanup_test_hook(hook: impl FnOnce() + 'static) {
    DISCARD_ALL_AFTER_CLEANUP_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(crate) fn set_discard_all_after_first_clean_batch_test_hook(hook: impl FnOnce() + 'static) {
    DISCARD_ALL_AFTER_FIRST_CLEAN_BATCH_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(crate) fn set_discard_all_before_tracked_reset_test_hook(hook: impl FnOnce() + 'static) {
    DISCARD_ALL_BEFORE_TRACKED_RESET_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(crate) fn set_discard_all_after_tracked_scope_validation_test_hook(
    hook: impl FnOnce() + 'static,
) {
    DISCARD_ALL_AFTER_TRACKED_SCOPE_VALIDATION_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(crate) fn start_discard_all_fingerprint_byte_count() {
    DISCARD_ALL_FINGERPRINT_BYTES_TEST.with(|count| count.set(Some(0)));
}

#[cfg(test)]
pub(crate) fn take_discard_all_fingerprint_byte_count() -> u64 {
    DISCARD_ALL_FINGERPRINT_BYTES_TEST.with(|count| {
        count
            .take()
            .expect("discard-all fingerprint byte counting was not started")
    })
}

#[cfg(test)]
fn run_capture_test_hook() {
    DISCARD_ALL_CAPTURE_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_capture_test_hook() {}

#[cfg(test)]
fn run_after_validation_test_hook() {
    DISCARD_ALL_AFTER_VALIDATION_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_after_validation_test_hook() {}

#[cfg(test)]
fn run_after_cleanup_test_hook() {
    DISCARD_ALL_AFTER_CLEANUP_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_after_cleanup_test_hook() {}

#[cfg(test)]
fn run_after_first_clean_batch_test_hook() {
    DISCARD_ALL_AFTER_FIRST_CLEAN_BATCH_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_after_first_clean_batch_test_hook() {}

#[cfg(test)]
fn run_before_tracked_reset_test_hook() {
    DISCARD_ALL_BEFORE_TRACKED_RESET_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_before_tracked_reset_test_hook() {}

#[cfg(test)]
fn run_after_tracked_scope_validation_test_hook() {
    DISCARD_ALL_AFTER_TRACKED_SCOPE_VALIDATION_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_after_tracked_scope_validation_test_hook() {}

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

fn enforce_fingerprint_budget(
    workdir: &Path,
    paths: impl IntoIterator<Item = OsString>,
) -> Result<(), String> {
    let mut unique = BTreeMap::new();
    for path in paths {
        unique.insert(git_bytes(&path)?, path);
    }
    let mut total = 0u64;
    for path in unique.values() {
        let size = worktree_regular_leaf_size_path(workdir, Path::new(path)).map_err(|error| {
            format!(
                "Could not inspect the size of {} before discarding: {error}",
                path_label(path)
            )
        })?;
        if let Some(size) = size {
            total = total.checked_add(size).ok_or_else(|| {
                "Discard all safety inspection size overflowed; use the terminal for this repository state."
                    .to_string()
            })?;
            if total > MAX_FINGERPRINT_BYTES {
                return Err(format!(
                    "Discard all would need to fingerprint more than {} MiB of changed or removable file content. Use the terminal for this unusually large repository state.",
                    MAX_FINGERPRINT_BYTES / (1024 * 1024)
                ));
            }
        }
    }
    Ok(())
}

fn fingerprint_with_budget(
    workdir: &Path,
    path: &OsStr,
    remaining_bytes: &mut u64,
    context: &str,
) -> Result<(WorktreeLeafFingerprint, WorktreeLeafObservation), String> {
    let (fingerprint, observation) =
        fingerprint_worktree_leaf_path_bounded(workdir, Path::new(path), *remaining_bytes)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::InvalidData {
                    format!(
                        "Discard all exceeded its {} MiB content-fingerprint limit while inspecting {}. Use the terminal for this unusually large or actively growing repository state.",
                        MAX_FINGERPRINT_BYTES / (1024 * 1024),
                        path_label(path)
                    )
                } else {
                    format!("{context}: {error}")
                }
            })?;
    if let WorktreeLeafFingerprint::Regular { len, .. } = &fingerprint {
        #[cfg(test)]
        DISCARD_ALL_FINGERPRINT_BYTES_TEST.with(|count| {
            if let Some(current) = count.get() {
                count.set(Some(current.saturating_add(*len)));
            }
        });
        *remaining_bytes = remaining_bytes.checked_sub(*len).ok_or_else(|| {
            format!(
                "Discard all exceeded its {} MiB content-fingerprint limit while inspecting {}. Use the terminal for this unusually large repository state.",
                MAX_FINGERPRINT_BYTES / (1024 * 1024),
                path_label(path)
            )
        })?;
    }
    Ok((fingerprint, observation))
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

fn validate_head_lease(snapshot: &DiscardAllSnapshot) -> Result<(), String> {
    let (repository, current_scope) = discover_scope(command_repo(&snapshot.scope)?)?;
    if current_scope != snapshot.scope {
        return Err(STALE_MESSAGE.to_string());
    }
    ensure_no_replace_refs(&snapshot.scope)?;
    let (branch, oid) = head_state(&repository)?;
    let tree_oid = effective_head_tree_oid(&snapshot.scope, oid.as_deref())?;
    if branch != snapshot.expected_head_branch
        || oid != snapshot.expected_head_oid
        || tree_oid != snapshot.expected_head_tree_oid
    {
        return Err(STALE_MESSAGE.to_string());
    }
    Ok(())
}

fn capture_index(repository: &Repository) -> Result<IndexSnapshot, String> {
    let index = repository
        .index()
        .map_err(|error| format!("Could not inspect the index before discarding: {error}"))?;
    let mut state = Sha256::new();
    hash_field(&mut state, b"gitlane-discard-all-index-v1");
    let mut stage_zero_paths = Vec::new();
    let mut count = 0u64;
    for entry in index.iter() {
        count += 1;
        let flags = IndexEntryFlag::from_bits_truncate(entry.flags);
        let extended = IndexEntryExtendedFlag::from_bits_truncate(entry.flags_extended);
        if flags.is_valid() {
            return Err(format!(
                "{} is marked assume-unchanged. Clear that index flag before using Discard all.",
                String::from_utf8_lossy(&entry.path)
            ));
        }
        if extended.is_skip_worktree() {
            return Err(format!(
                "{} is marked skip-worktree (or belongs to a sparse index). Disable sparse/skip-worktree state before using Discard all.",
                String::from_utf8_lossy(&entry.path)
            ));
        }
        let stage = ((entry.flags >> 12) & 0x3) as u8;
        if stage != 0 {
            return Err(
                "Conflicted index entries are present. Resolve or abort the operation before using Discard all."
                    .to_string(),
            );
        }
        stage_zero_paths.push(entry.path.clone());
        hash_field(&mut state, &entry.path);
        state.update(entry.id.as_bytes());
        state.update(entry.mode.to_le_bytes());
        state.update(entry.flags.to_le_bytes());
        state.update(entry.flags_extended.to_le_bytes());
    }
    state.update(count.to_le_bytes());
    Ok(IndexSnapshot {
        digest: state.finalize().into(),
        stage_zero_paths,
    })
}

fn read_status(scope: &RepositoryScope) -> Result<ParsedStatus, String> {
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
    let mut semantic_records = Vec::new();
    let mut tracked_paths = BTreeSet::new();
    let mut display = Vec::new();
    let mut cursor = 0usize;
    while cursor < raw.len() {
        let end = raw[cursor..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|offset| cursor + offset)
            .ok_or_else(|| "Git returned a malformed status record.".to_string())?;
        let record = &raw[cursor..end];
        cursor = end + 1;
        if record.is_empty() {
            continue;
        }
        if record.len() < 4 || record[2] != b' ' {
            return Err("Git returned a malformed status record.".to_string());
        }
        let code = &record[..2];
        let path = record[3..].to_vec();
        let rename = code.iter().any(|byte| matches!(*byte, b'R' | b'C'));
        let second = if rename {
            let second_end = raw[cursor..]
                .iter()
                .position(|byte| *byte == 0)
                .map(|offset| cursor + offset)
                .ok_or_else(|| "Git returned a malformed rename status record.".to_string())?;
            let value = raw[cursor..second_end].to_vec();
            cursor = second_end + 1;
            Some(value)
        } else {
            None
        };
        let mut semantic = record.to_vec();
        if let Some(other) = &second {
            semantic.push(0);
            semantic.extend_from_slice(other);
        }
        semantic_records.push(semantic);
        if code != b"??" && code != b"!!" {
            tracked_paths.insert(path.clone());
            if let Some(other) = &second {
                tracked_paths.insert(other.clone());
            }
        }
        let code_label = String::from_utf8_lossy(code);
        let path_label = String::from_utf8_lossy(&path);
        let mut display_paths = vec![path.clone()];
        if let Some(other) = &second {
            display_paths.push(other.clone());
        }
        let label = match second {
            Some(other) => format!(
                "{code_label} {} -> {path_label}",
                String::from_utf8_lossy(&other)
            ),
            None => format!("{code_label} {path_label}"),
        };
        display.push(StatusDisplay {
            label,
            paths: display_paths,
        });
    }
    Ok(ParsedStatus {
        semantic_records,
        tracked_paths,
        display,
    })
}

fn parse_nul_paths(raw: &[u8]) -> Result<Vec<OsString>, String> {
    raw.split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(git_path)
        .collect()
}

fn untracked_paths(scope: &RepositoryScope) -> Result<Vec<OsString>, String> {
    parse_nul_paths(&run_scoped_git_stdout_raw(
        scope,
        &[
            "-c",
            "core.fsmonitor=false",
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    )?)
}

fn looks_like_bare_repository(candidate: &Path) -> bool {
    candidate.join("HEAD").is_file()
        && candidate.join("objects").is_dir()
        && (candidate.join("refs").is_dir() || candidate.join("packed-refs").is_file())
}

fn has_git_marker(candidate: &Path) -> bool {
    match std::fs::symlink_metadata(candidate.join(".git")) {
        Ok(_) => true,
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

fn nested_repository_root(workdir: &Path, path: &OsStr) -> Option<OsString> {
    Path::new(path).ancestors().find_map(|relative| {
        if relative.as_os_str().is_empty() {
            return None;
        }
        let candidate = workdir.join(relative);
        let directory = std::fs::symlink_metadata(&candidate)
            .map(|metadata| metadata.file_type().is_dir())
            .unwrap_or(false);
        if directory && (has_git_marker(&candidate) || looks_like_bare_repository(&candidate)) {
            Some(relative.as_os_str().to_os_string())
        } else {
            None
        }
    })
}

fn reject_tracked_paths_in_nested_repositories(
    workdir: &Path,
    status: &ParsedStatus,
) -> Result<(), String> {
    for raw_path in &status.tracked_paths {
        let path = git_path(raw_path)?;
        if let Some(root) = nested_repository_root(workdir, &path) {
            return Err(format!(
                "Tracked parent-repository path {} is now inside nested Git repository {}. The newer nested repository and its files were preserved; refresh and preview again.",
                path_label(&path),
                path_label(&root)
            ));
        }
    }
    Ok(())
}

struct TrackedDigestContext<'a> {
    scope: &'a RepositoryScope,
    head_branch: Option<&'a str>,
    head_oid: Option<&'a str>,
    head_tree_oid: Option<&'a str>,
    index: &'a IndexSnapshot,
    status: &'a ParsedStatus,
}

fn begin_tracked_digest(context: &TrackedDigestContext<'_>) -> Sha256 {
    let TrackedDigestContext {
        scope,
        head_branch,
        head_oid,
        head_tree_oid,
        index,
        status,
    } = context;
    let mut state = Sha256::new();
    hash_field(&mut state, b"gitlane-discard-all-tracked-v1");
    hash_os(&mut state, scope.workdir.as_os_str());
    hash_os(&mut state, scope.gitdir.as_os_str());
    hash_os(&mut state, scope.commondir.as_os_str());
    scope.workdir_identity.hash_into(&mut state);
    scope.gitdir_identity.hash_into(&mut state);
    scope.commondir_identity.hash_into(&mut state);
    state.update([u8::from(scope.is_worktree)]);
    match head_branch {
        Some(branch) => {
            state.update([1]);
            hash_field(&mut state, branch.as_bytes());
        }
        None => state.update([0]),
    }
    match head_oid {
        Some(oid) => {
            state.update([1]);
            hash_field(&mut state, oid.as_bytes());
        }
        None => state.update([0]),
    }
    match head_tree_oid {
        Some(oid) => {
            state.update([1]);
            hash_field(&mut state, oid.as_bytes());
        }
        None => state.update([0]),
    }
    hash_field(&mut state, &index.digest);
    let tracked_records = status
        .semantic_records
        .iter()
        .filter(|record| !record.starts_with(b"?? ") && !record.starts_with(b"!! "))
        .collect::<Vec<_>>();
    state.update((tracked_records.len() as u64).to_le_bytes());
    for record in tracked_records {
        hash_field(&mut state, record);
    }
    state.update((status.tracked_paths.len() as u64).to_le_bytes());
    state
}

fn capture_tracked_digest(
    context: &TrackedDigestContext<'_>,
    normalized_missing: &BTreeSet<Vec<u8>>,
    verify_normalized_missing: bool,
    remaining_bytes: &mut u64,
) -> Result<TrackedCapture, String> {
    let mut state = begin_tracked_digest(context);
    let mut observations = Vec::new();
    let mut fingerprints = BTreeMap::new();
    for raw_path in &context.status.tracked_paths {
        hash_field(&mut state, raw_path);
        let path = git_path(raw_path)?;
        if normalized_missing.contains(raw_path) {
            if verify_normalized_missing {
                let (fingerprint, observation) = fingerprint_with_budget(
                    &context.scope.workdir,
                    &path,
                    remaining_bytes,
                    &format!(
                        "Could not inspect cleaned path {} before reset",
                        path_label(&path)
                    ),
                )?;
                if !matches!(&fingerprint, WorktreeLeafFingerprint::Missing) {
                    return Err(format!(
                        "Approved cleanup path {} was recreated before reset; the newer file was preserved.",
                        path_label(&path)
                    ));
                }
                let observation = Arc::new(observation);
                fingerprints.insert(raw_path.clone(), (fingerprint, Arc::clone(&observation)));
                observations.push(TrackedLeaf { path, observation });
            }
            state.update([0]);
            continue;
        }
        let (fingerprint, observation) = fingerprint_with_budget(
            &context.scope.workdir,
            &path,
            remaining_bytes,
            &format!("Could not inspect {} before discarding", path_label(&path)),
        )?;
        fingerprint_into(&mut state, &fingerprint, &path_label(&path))?;
        let observation = Arc::new(observation);
        fingerprints.insert(raw_path.clone(), (fingerprint, Arc::clone(&observation)));
        observations.push(TrackedLeaf { path, observation });
    }
    Ok(TrackedCapture {
        digest: state.finalize().into(),
        observations,
        fingerprints,
    })
}

fn digest_tracked_from_captured(
    context: &TrackedDigestContext<'_>,
    normalized_missing: &BTreeSet<Vec<u8>>,
    fingerprints: &BTreeMap<Vec<u8>, (WorktreeLeafFingerprint, Arc<WorktreeLeafObservation>)>,
) -> Result<[u8; 32], String> {
    let mut state = begin_tracked_digest(context);
    for raw_path in &context.status.tracked_paths {
        hash_field(&mut state, raw_path);
        if normalized_missing.contains(raw_path) {
            state.update([0]);
            continue;
        }
        let (fingerprint, _) = fingerprints
            .get(raw_path)
            .ok_or_else(|| STALE_MESSAGE.to_string())?;
        fingerprint_into(&mut state, fingerprint, &path_label(&git_path(raw_path)?))?;
    }
    Ok(state.finalize().into())
}

fn capture_once(repo: &str) -> Result<DiscardAllSnapshot, String> {
    let (repository, scope) = discover_scope(repo)?;
    ensure_no_replace_refs(&scope)?;
    let status = read_status(&scope)?;
    let index = capture_index(&repository)?;
    let (expected_head_branch, expected_head_oid) = head_state(&repository)?;
    if expected_head_oid.is_none() {
        return Err(
            "Discard all is unavailable before the first commit because there is no committed tree to restore. Unstage or remove files individually, or use the terminal."
                .to_string(),
        );
    }
    let expected_head_tree_oid = effective_head_tree_oid(&scope, expected_head_oid.as_deref())?;

    let mut cleanup_by_path: BTreeMap<Vec<u8>, (OsString, CleanupKind)> = BTreeMap::new();
    let reported_untracked = untracked_paths(&scope)?;
    let mut nested_roots = BTreeMap::new();
    for path in &reported_untracked {
        if let Some(root) = nested_repository_root(&scope.workdir, path) {
            nested_roots.insert(git_bytes(&root)?, root);
        }
    }
    for raw_path in &status.tracked_paths {
        let path = git_path(raw_path)?;
        if let Some(root) = nested_repository_root(&scope.workdir, &path) {
            nested_roots.insert(git_bytes(&root)?, root);
        }
    }
    let preserved_nested_repos = nested_roots.values().cloned().collect::<Vec<_>>();
    for raw_path in &status.tracked_paths {
        let path = git_path(raw_path)?;
        if let Some(root) = preserved_nested_repos
            .iter()
            .find(|root| Path::new(&path).starts_with(Path::new(root)))
        {
            return Err(format!(
                "Nested Git repository {} has staged or tracked parent-repository changes. Refusing Discard all because a global tracked-tree restore could damage it; unstage or move it outside this worktree first.",
                path_label(root)
            ));
        }
    }
    for path in reported_untracked {
        if preserved_nested_repos
            .iter()
            .any(|root| Path::new(&path).starts_with(Path::new(root)))
        {
            continue;
        }
        cleanup_by_path.insert(git_bytes(&path)?, (path, CleanupKind::Ordinary));
    }
    let cleanup_raw = cleanup_by_path.keys().cloned().collect::<BTreeSet<_>>();
    let inspection_paths = status
        .tracked_paths
        .iter()
        .map(|path| git_path(path))
        .chain(cleanup_by_path.values().map(|(path, _)| Ok(path.clone())))
        .collect::<Result<Vec<_>, String>>()?;
    enforce_fingerprint_budget(&scope.workdir, inspection_paths)?;
    let mut remaining_bytes = MAX_FINGERPRINT_BYTES;
    let digest_context = TrackedDigestContext {
        scope: &scope,
        head_branch: expected_head_branch.as_deref(),
        head_oid: expected_head_oid.as_deref(),
        head_tree_oid: expected_head_tree_oid.as_deref(),
        index: &index,
        status: &status,
    };
    let tracked_capture = capture_tracked_digest(
        &digest_context,
        &BTreeSet::new(),
        false,
        &mut remaining_bytes,
    )?;
    let stage_zero_paths = index
        .stage_zero_paths
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    for raw_path in &status.tracked_paths {
        if stage_zero_paths.contains(raw_path) || cleanup_raw.contains(raw_path) {
            continue;
        }
        let (fingerprint, _) = tracked_capture.fingerprints.get(raw_path).ok_or_else(|| {
            format!(
                "Could not inspect the staged deletion at {}.",
                String::from_utf8_lossy(raw_path)
            )
        })?;
        if !matches!(fingerprint, WorktreeLeafFingerprint::Missing) {
            return Err(format!(
                "{} is staged for deletion but currently contains an ignored or otherwise unapproved replacement. Remove or preserve that replacement manually before using Discard all.",
                path_label(&git_path(raw_path)?)
            ));
        }
    }
    let tracked_state = tracked_capture.digest;
    let post_cleanup_tracked_state = if cleanup_raw
        .iter()
        .any(|path| status.tracked_paths.contains(path))
    {
        digest_tracked_from_captured(&digest_context, &cleanup_raw, &tracked_capture.fingerprints)?
    } else {
        tracked_state
    };

    let mut full = Sha256::new();
    hash_field(&mut full, b"gitlane-discard-all-v1");
    hash_field(&mut full, &tracked_state);
    hash_field(&mut full, &post_cleanup_tracked_state);
    full.update((cleanup_by_path.len() as u64).to_le_bytes());
    let mut cleanup = Vec::with_capacity(cleanup_by_path.len());
    for (raw_path, (path, kind)) in cleanup_by_path {
        hash_os(&mut full, &path);
        full.update([match kind {
            CleanupKind::Ordinary => 0,
        }]);
        let observation = match tracked_capture.fingerprints.get(&raw_path) {
            Some((fingerprint, observation)) => {
                fingerprint_into(&mut full, fingerprint, &path_label(&path))?;
                Arc::clone(observation)
            }
            None => {
                let (fingerprint, observation) = fingerprint_with_budget(
                    &scope.workdir,
                    &path,
                    &mut remaining_bytes,
                    &format!(
                        "Could not inspect removable path {} before discarding",
                        path_label(&path)
                    ),
                )?;
                fingerprint_into(&mut full, &fingerprint, &path_label(&path))?;
                Arc::new(observation)
            }
        };
        cleanup.push(CleanupLeaf {
            path,
            kind,
            observation,
        });
    }
    full.update((preserved_nested_repos.len() as u64).to_le_bytes());
    for path in &preserved_nested_repos {
        hash_os(&mut full, path);
    }
    let mut display_status = Vec::new();
    for entry in &status.display {
        let mut protected = false;
        for raw_path in &entry.paths {
            let path = git_path(raw_path)?;
            if preserved_nested_repos
                .iter()
                .any(|root| Path::new(&path).starts_with(Path::new(root)))
            {
                protected = true;
                break;
            }
        }
        if !protected {
            display_status.push(entry.label.clone());
        }
    }
    Ok(DiscardAllSnapshot {
        expected_state: format!("v1:{}", URL_SAFE_NO_PAD.encode(full.finalize())),
        tracked_state,
        post_cleanup_tracked_state,
        scope,
        expected_head_branch,
        expected_head_oid,
        expected_head_tree_oid,
        cleanup,
        tracked: tracked_capture.observations,
        tracked_fingerprints: tracked_capture.fingerprints,
        preserved_nested_repos,
        display_status,
    })
}

fn validate_observations(snapshot: &DiscardAllSnapshot) -> Result<(), String> {
    validate_repository_scope(&snapshot.scope)?;
    for leaf in &snapshot.tracked {
        if !validate_worktree_leaf_observation_path(
            &snapshot.scope.workdir,
            Path::new(&leaf.path),
            &leaf.observation,
        )
        .map_err(|error| {
            format!(
                "Could not recheck tracked path {}: {error}",
                path_label(&leaf.path)
            )
        })? {
            return Err(STALE_MESSAGE.to_string());
        }
    }
    for leaf in &snapshot.cleanup {
        if !validate_worktree_leaf_observation_path(
            &snapshot.scope.workdir,
            Path::new(&leaf.path),
            &leaf.observation,
        )
        .map_err(|error| {
            format!(
                "Could not recheck removable path {}: {error}",
                path_label(&leaf.path)
            )
        })? {
            return Err(STALE_MESSAGE.to_string());
        }
    }
    Ok(())
}

fn capture_stable(repo: &str) -> Result<DiscardAllSnapshot, String> {
    let initial = capture_once(repo)?;
    run_capture_test_hook();
    let fresh = capture_once(repo)?;
    if initial.expected_state != fresh.expected_state {
        return Err(
            "The working tree changed while GitLane was preparing the discard preview. Try again."
                .to_string(),
        );
    }
    validate_observations(&fresh)?;
    Ok(fresh)
}

fn capture_current_tracked_from_snapshot_once(
    snapshot: &DiscardAllSnapshot,
) -> Result<[u8; 32], String> {
    let (repository, scope) = discover_scope(command_repo(&snapshot.scope)?)?;
    if scope != snapshot.scope {
        return Err(STALE_MESSAGE.to_string());
    }
    let status = read_status(&scope)?;
    reject_tracked_paths_in_nested_repositories(&scope.workdir, &status)?;
    let index = capture_index(&repository)?;
    let (branch, oid) = head_state(&repository)?;
    let tree_oid = effective_head_tree_oid(&scope, oid.as_deref())?;
    validate_observations(snapshot)?;
    reject_tracked_paths_in_nested_repositories(&scope.workdir, &status)?;
    let digest_context = TrackedDigestContext {
        scope: &scope,
        head_branch: branch.as_deref(),
        head_oid: oid.as_deref(),
        head_tree_oid: tree_oid.as_deref(),
        index: &index,
        status: &status,
    };
    digest_tracked_from_captured(
        &digest_context,
        &BTreeSet::new(),
        &snapshot.tracked_fingerprints,
    )
}

fn capture_current_tracked_from_snapshot(
    snapshot: &DiscardAllSnapshot,
) -> Result<[u8; 32], String> {
    let initial = capture_current_tracked_from_snapshot_once(snapshot)?;
    let fresh = capture_current_tracked_from_snapshot_once(snapshot)?;
    if initial != fresh {
        return Err(
            "Tracked state changed while GitLane was rechecking it; tracked edits were preserved."
                .to_string(),
        );
    }
    Ok(fresh)
}

fn capture_current_tracked_once(
    expected_scope: &RepositoryScope,
    normalized_missing: &BTreeSet<Vec<u8>>,
) -> Result<[u8; 32], String> {
    let (repository, scope) = discover_scope(command_repo(expected_scope)?)?;
    if scope != *expected_scope {
        return Err(STALE_MESSAGE.to_string());
    }
    let status = read_status(&scope)?;
    reject_tracked_paths_in_nested_repositories(&scope.workdir, &status)?;
    let index = capture_index(&repository)?;
    let (branch, oid) = head_state(&repository)?;
    let tree_oid = effective_head_tree_oid(&scope, oid.as_deref())?;
    let inspection_paths = status
        .tracked_paths
        .iter()
        .map(|path| git_path(path))
        .collect::<Result<Vec<_>, String>>()?;
    enforce_fingerprint_budget(&scope.workdir, inspection_paths)?;
    let mut remaining_bytes = MAX_FINGERPRINT_BYTES;
    let TrackedCapture {
        digest,
        observations,
        ..
    } = capture_tracked_digest(
        &TrackedDigestContext {
            scope: &scope,
            head_branch: branch.as_deref(),
            head_oid: oid.as_deref(),
            head_tree_oid: tree_oid.as_deref(),
            index: &index,
            status: &status,
        },
        normalized_missing,
        !normalized_missing.is_empty(),
        &mut remaining_bytes,
    )?;
    for leaf in observations {
        if !validate_worktree_leaf_observation_path(
            &scope.workdir,
            Path::new(&leaf.path),
            &leaf.observation,
        )
        .map_err(|error| {
            format!(
                "Could not recheck tracked path {}: {error}",
                path_label(&leaf.path)
            )
        })? {
            return Err(STALE_MESSAGE.to_string());
        }
    }
    reject_tracked_paths_in_nested_repositories(&scope.workdir, &status)?;
    Ok(digest)
}

fn capture_current_tracked(
    expected_scope: &RepositoryScope,
    normalized_missing: &BTreeSet<Vec<u8>>,
) -> Result<[u8; 32], String> {
    let initial = capture_current_tracked_once(expected_scope, normalized_missing)?;
    let fresh = capture_current_tracked_once(expected_scope, normalized_missing)?;
    if initial != fresh {
        return Err(
            "Tracked state changed while GitLane was rechecking it; tracked edits were preserved."
                .to_string(),
        );
    }
    Ok(fresh)
}

fn cleanup_paths<'a>(
    scope: &RepositoryScope,
    leaves: impl Iterator<Item = &'a CleanupLeaf>,
    include_ignored: bool,
) -> Result<bool, String> {
    let leaves = leaves.collect::<Vec<_>>();
    if leaves.is_empty() {
        return Ok(false);
    }
    let mut start = 0usize;
    while start < leaves.len() {
        let mut end = start;
        let mut bytes = 0usize;
        while end < leaves.len() && end - start < CLEAN_PATH_BATCH_MAX_ARGS {
            let next = os_bytes(&leaves[end].path).len() + 1;
            if end > start && bytes + next > CLEAN_PATH_BATCH_MAX_BYTES {
                break;
            }
            bytes += next;
            end += 1;
        }
        validate_repository_scope(scope).map_err(|error| {
            if start > 0 {
                format!(
                    "Approved untracked cleanup partially completed, but the repository scope changed before the next cleanup batch; the remaining files were preserved: {error}"
                )
            } else {
                error
            }
        })?;
        for leaf in &leaves[start..end] {
            if let Some(root) = nested_repository_root(&scope.workdir, &leaf.path) {
                return Err(if start > 0 {
                    format!(
                        "Approved untracked cleanup partially completed, but {} is now inside nested Git repository {}; the remaining files were preserved.",
                        path_label(&leaf.path),
                        path_label(&root)
                    )
                } else {
                    format!(
                        "Repository state changed after confirmation: {} is now inside nested Git repository {}; no files were removed. Refresh and preview again.",
                        path_label(&leaf.path),
                        path_label(&root)
                    )
                });
            }
            let unchanged = validate_worktree_leaf_observation_path(
                &scope.workdir,
                Path::new(&leaf.path),
                &leaf.observation,
            )
            .map_err(|error| {
                if start > 0 {
                    format!(
                        "Approved untracked cleanup partially completed, but {} could not be rechecked before its cleanup batch; the remaining files were preserved: {error}",
                        path_label(&leaf.path)
                    )
                } else {
                    format!(
                        "Could not recheck approved cleanup path {}: {error}",
                        path_label(&leaf.path)
                    )
                }
            })?;
            if !unchanged {
                return Err(if start > 0 {
                    format!(
                        "Approved untracked cleanup partially completed, but {} changed before its cleanup batch; the newer file was preserved.",
                        path_label(&leaf.path)
                    )
                } else {
                    STALE_MESSAGE.to_string()
                });
            }
        }
        let prefix: &[&str] = if include_ignored {
            &["--literal-pathspecs", "clean", "-f", "-x", "--"]
        } else {
            &["--literal-pathspecs", "clean", "-f", "--"]
        };
        let batch_paths = leaves[start..end]
            .iter()
            .map(|leaf| leaf.path.clone())
            .collect::<Vec<_>>();
        run_scoped_git_paths(scope, prefix, &batch_paths).map_err(|error| {
            format!(
                "Approved untracked cleanup could not finish; some approved files may already have been removed: {error}"
            )
        })?;
        if start == 0 {
            run_after_first_clean_batch_test_hook();
        }
        start = end;
    }
    validate_repository_scope(scope).map_err(|error| {
        format!(
            "Approved untracked cleanup ran, but the repository scope changed before GitLane could verify it: {error}"
        )
    })?;
    for leaf in &leaves {
        let missing = worktree_leaf_is_missing_path(&scope.workdir, Path::new(&leaf.path))
            .map_err(|error| {
                format!(
                    "Approved untracked cleanup ran, but GitLane could not verify removal of {}: {error}",
                    path_label(&leaf.path)
                )
            })?;
        if !missing {
            return Err(format!(
                "Approved untracked cleanup ran, but did not remove {}.",
                path_label(&leaf.path)
            ));
        }
    }
    Ok(true)
}

fn cleanup_set(
    snapshot: &DiscardAllSnapshot,
    kind: CleanupKind,
) -> Result<BTreeSet<Vec<u8>>, String> {
    snapshot
        .cleanup
        .iter()
        .filter(|leaf| leaf.kind == kind)
        .map(|leaf| git_bytes(&leaf.path))
        .collect()
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
    use super::{
        begin_tracked_digest, IndexSnapshot, ParsedStatus, RepositoryScope, TrackedDigestContext,
    };
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
