//! Exact-state lease for destructive hard resets (GL-302).
//!
//! Soft/mixed resets keep working-tree content; hard reset does not. The
//! confirmation therefore captures repository scope, HEAD, index, and worktree
//! fingerprints, then the write re-captures and compares before any mutation.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{OsStr, OsString};
use std::path::Path;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use git2::{IndexEntryExtendedFlag, IndexEntryFlag, Oid, Repository};
use sha2::{Digest, Sha256};

#[cfg(unix)]
use std::os::unix::ffi::OsStringExt;

use crate::git::worktree_fs::{
    fingerprint_worktree_leaf_path_bounded, validate_worktree_leaf_observation_path,
    worktree_directory_identity, WorktreeDirectoryIdentity, WorktreeLeafFingerprint,
    WorktreeLeafObservation,
};

use super::cli::run_git_scoped_os;
use super::state_lease::{
    self, hash_field, hash_os, path_label, scoped_git_args, LeaseError, RepositoryScope,
    MAX_FINGERPRINT_BYTES,
};

/// Render a shared-primitive failure in this operation's own words.
fn describe_lease_error(error: LeaseError) -> String {
    match error {
        LeaseError::WorkdirNotUtf8 => {
            "Cannot lease a hard reset from a worktree path that is not valid UTF-8.".to_string()
        }
        LeaseError::Worded(text) => text,
    }
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

pub(super) const STALE_MESSAGE: &str =
    "The repository changed after this confirmation opened. Preview the hard reset again.";

/// Re-capture failed, so drift could be neither confirmed nor ruled out.
///
/// Distinct from [`STALE_MESSAGE`]: a retargeted worktree and an unreadable
/// index both land here, and asserting "the repository changed" for the second
/// sends the user to re-preview a problem that re-previewing will not fix. What
/// both cases share — and what the user needs first — is that nothing was reset.
pub(super) const UNVERIFIABLE_MESSAGE: &str =
    "Could not re-check the repository state, so the hard reset was not performed.";

/// One `git status --porcelain=v1 -z` read: the records the lease hashes, and
/// the paths whose content it then fingerprints.
struct ParsedStatus {
    semantic_records: Vec<Vec<u8>>,
    dirty_paths: BTreeSet<Vec<u8>>,
}

struct HardResetSnapshot {
    expected_state: String,
    expected_head_branch: Option<String>,
    expected_head_oid: Option<String>,
    target_oid: String,
    /// The scope this snapshot was taken in, kept so the mutation can be routed
    /// through the very scope that was validated — see [`ValidatedScope`].
    scope: RepositoryScope,
    /// Cheap per-leaf metadata, by raw git path. Not hashed into the token —
    /// consumed by [`validate_observations`] to close the intra-capture window.
    observations: BTreeMap<Vec<u8>, WorktreeLeafObservation>,
}

/// A repository scope proved current by [`validate_at_mutation_boundary`].
///
/// Validation resolves and checks one canonical gitdir/workdir pair, but a
/// caller that then shells out via the original repo *path* lets git re-discover
/// the scope — and a `.git`-file or linked-worktree retarget in that window
/// would point the reset somewhere the lease never covered. Holding the proved
/// scope in a value the mutation must go through closes that window by
/// construction rather than by comment (GL-302 review).
pub(super) struct ValidatedScope(RepositoryScope);

impl ValidatedScope {
    /// Run a git subcommand pinned to the validated `--git-dir`/`--work-tree`.
    pub(super) fn run(&self, args: &[&str]) -> Result<String, String> {
        run_git_scoped_os(
            command_repo(&self.0)?,
            self.0.commondir.as_os_str(),
            &scoped_git_args(&self.0, args),
        )
    }
}

#[cfg(test)]
std::thread_local! {
    static HARD_RESET_CAPTURE_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    /// Fires after tip/HEAD preparation and immediately before the final lease
    /// re-capture that sits next to `git reset --hard` (GL-302 review).
    static HARD_RESET_BEFORE_MUTATION_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    /// Fires in the window the lease cannot close: after validation succeeded,
    /// before the `git reset --hard` process is launched (GL-302 review).
    static HARD_RESET_AFTER_VALIDATION_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
    /// Fires inside a capture, after every leaf has been fingerprinted but
    /// before the observation sweep — the intra-capture window an edit to an
    /// already-hashed file would otherwise slip through (GL-302 review).
    static HARD_RESET_AFTER_FINGERPRINT_TEST_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

#[cfg(test)]
pub(crate) fn set_hard_reset_capture_test_hook(hook: impl FnOnce() + 'static) {
    HARD_RESET_CAPTURE_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(crate) fn set_hard_reset_before_mutation_test_hook(hook: impl FnOnce() + 'static) {
    HARD_RESET_BEFORE_MUTATION_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(crate) fn set_hard_reset_after_validation_test_hook(hook: impl FnOnce() + 'static) {
    HARD_RESET_AFTER_VALIDATION_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
pub(crate) fn set_hard_reset_after_fingerprint_test_hook(hook: impl FnOnce() + 'static) {
    HARD_RESET_AFTER_FINGERPRINT_TEST_HOOK.with(|slot| {
        assert!(slot.borrow_mut().replace(Box::new(hook)).is_none());
    });
}

#[cfg(test)]
fn run_after_fingerprint_test_hook() {
    HARD_RESET_AFTER_FINGERPRINT_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_after_fingerprint_test_hook() {}

#[cfg(test)]
fn run_capture_test_hook() {
    HARD_RESET_CAPTURE_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
fn run_capture_test_hook() {}

#[cfg(test)]
pub(super) fn run_before_mutation_test_hook() {
    HARD_RESET_BEFORE_MUTATION_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
pub(super) fn run_before_mutation_test_hook() {}

#[cfg(test)]
pub(super) fn run_after_validation_test_hook() {
    HARD_RESET_AFTER_VALIDATION_TEST_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}

#[cfg(not(test))]
pub(super) fn run_after_validation_test_hook() {}

fn hash_identity(state: &mut Sha256, identity: &WorktreeDirectoryIdentity) {
    state.update(identity.device.to_le_bytes());
    state.update(identity.inode.to_le_bytes());
}

fn fingerprint_into(
    state: &mut Sha256,
    fingerprint: &WorktreeLeafFingerprint,
    label: &str,
) -> Result<(), String> {
    match fingerprint {
        WorktreeLeafFingerprint::Missing => state.update([0]),
        WorktreeLeafFingerprint::Regular { len, mode, digest } => {
            state.update([1]);
            state.update(len.to_le_bytes());
            state.update(mode.to_le_bytes());
            state.update(digest);
        }
        WorktreeLeafFingerprint::Symlink { mode, target } => {
            state.update([2]);
            state.update(mode.to_le_bytes());
            hash_field(state, target);
        }
        WorktreeLeafFingerprint::Other { mode, kind } => {
            return Err(format!(
                "Refusing to hard-reset while non-file worktree path {label} is present (type {kind}, mode {mode:o}). Move it aside and try again."
            ));
        }
    }
    Ok(())
}

fn git_path(bytes: &[u8]) -> Result<OsString, String> {
    #[cfg(unix)]
    {
        Ok(OsString::from_vec(bytes.to_vec()))
    }
    #[cfg(not(unix))]
    {
        String::from_utf8(bytes.to_vec())
            .map(OsString::from)
            .map_err(|_| {
                "Hard reset cannot safely represent a non-UTF-8 Git path on this platform."
                    .to_string()
            })
    }
}

fn discover_scope(repo: &str) -> Result<(Repository, RepositoryScope), String> {
    let repository = Repository::discover(repo)
        .map_err(|error| format!("Could not inspect the repository before hard reset: {error}"))?;
    let workdir = repository
        .workdir()
        .ok_or_else(|| "Cannot hard-reset a bare repository.".to_string())?
        .canonicalize()
        .map_err(|error| format!("Could not resolve the repository worktree: {error}"))?;
    let gitdir = repository
        .path()
        .canonicalize()
        .map_err(|error| format!("Could not resolve the repository metadata directory: {error}"))?;
    let commondir = repository.commondir().canonicalize().map_err(|error| {
        format!("Could not resolve the repository common metadata directory: {error}")
    })?;
    let workdir_identity = worktree_directory_identity(&workdir)
        .map_err(|error| format!("Could not identify the repository worktree: {error}"))?;
    let gitdir_identity = worktree_directory_identity(&gitdir).map_err(|error| {
        format!("Could not identify the repository metadata directory: {error}")
    })?;
    let commondir_identity = worktree_directory_identity(&commondir).map_err(|error| {
        format!("Could not identify the repository common metadata directory: {error}")
    })?;
    let is_worktree = repository.is_worktree();
    Ok((
        repository,
        RepositoryScope {
            workdir,
            gitdir,
            commondir,
            workdir_identity,
            gitdir_identity,
            commondir_identity,
            is_worktree,
        },
    ))
}

fn head_state(repository: &Repository) -> Result<(Option<String>, Option<String>), String> {
    let head = repository
        .find_reference("HEAD")
        .map_err(|error| format!("Could not inspect HEAD before hard reset: {error}"))?;
    let branch = match head.symbolic_target_bytes() {
        Some(target) => {
            let name = target.strip_prefix(b"refs/heads/").ok_or_else(|| {
                "HEAD points outside refs/heads; use the terminal for this repository state."
                    .to_string()
            })?;
            Some(
                std::str::from_utf8(name)
                    .map_err(|_| "HEAD branch is not valid UTF-8.".to_string())?
                    .to_string(),
            )
        }
        None => None,
    };
    let oid = match head.resolve() {
        Ok(resolved) => resolved.target().map(|oid| oid.to_string()),
        Err(error)
            if matches!(
                error.code(),
                git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound
            ) =>
        {
            None
        }
        Err(error) => return Err(format!("Could not resolve HEAD before hard reset: {error}")),
    };
    Ok((branch, oid))
}

fn effective_tree_oid_no_replace(
    scope: &RepositoryScope,
    commit_oid: &str,
) -> Result<String, String> {
    let tree_spec = format!("{commit_oid}^{{tree}}");
    let raw = run_scoped_git_stdout_raw(
        scope,
        &[
            "--no-replace-objects",
            "rev-parse",
            "--verify",
            "--end-of-options",
            &tree_spec,
        ],
    )?;
    let text = std::str::from_utf8(&raw)
        .map_err(|_| "Git returned a non-UTF-8 target tree object id.".to_string())?;
    let value = text.trim_end_matches(['\r', '\n']);
    if value.contains('\r') || value.contains('\n') {
        return Err("Git returned a malformed target tree object id.".to_string());
    }
    let oid = Oid::from_str(value)
        .map_err(|_| "Git returned a malformed target tree object id.".to_string())?;
    Ok(oid.to_string())
}

fn ensure_no_replace_refs(scope: &RepositoryScope) -> Result<(), String> {
    let refs = run_scoped_git_stdout_raw(
        scope,
        &["for-each-ref", "--format=%(refname)", "refs/replace/"],
    )?;
    if refs.iter().any(|byte| !byte.is_ascii_whitespace()) {
        return Err(
            "Hard reset is unavailable while Git replacement refs are active. Remove the replacement refs or use the terminal."
                .to_string(),
        );
    }
    Ok(())
}

fn path_conflicts_with_reset_target(untracked: &[u8], target_path: &[u8]) -> bool {
    untracked == target_path
        || (untracked.starts_with(target_path) && untracked.get(target_path.len()) == Some(&b'/'))
        || (target_path.starts_with(untracked) && target_path.get(untracked.len()) == Some(&b'/'))
}

/// Whether this checkout resolves paths case-insensitively.
///
/// Git probes the filesystem at init/clone and records the answer in
/// `core.ignorecase`, so it is the authoritative signal — a default macOS (APFS)
/// or Windows checkout is case-insensitive. When the key is missing we fall back
/// to the platform default rather than assuming the permissive answer.
fn case_insensitive_paths(repository: &Repository) -> bool {
    repository
        .config()
        .and_then(|config| config.get_bool("core.ignorecase"))
        .unwrap_or(cfg!(any(target_os = "macos", target_os = "windows")))
}

/// The form of `path` used to compare it against target-tree paths.
///
/// Case folding is ASCII-only: it catches `Foo` vs `foo`, the collision that
/// actually occurs, without pulling in a Unicode dependency. Paths differing
/// only by Unicode case or NFC/NFD normalization are therefore still missed —
/// see [`target_obstruction_paths`].
fn obstruction_key(path: &[u8], case_insensitive: bool) -> Vec<u8> {
    if case_insensitive {
        path.to_ascii_lowercase()
    } else {
        path.to_vec()
    }
}

/// Untracked paths (including ignored) that `git reset --hard` may overwrite
/// because they collide with a path in the target tree. Status porcelain omits
/// ignored files, so these must be leased separately (GL-302 review).
///
/// On a case-insensitive checkout an ignored `Foo` and a tracked target `foo`
/// are the *same* filesystem entry, so the comparison folds case there — GitLane
/// runs on macOS, where that is the default. Over-matching is the safe
/// direction: a false positive only leases one extra path, while a miss leaves a
/// file the reset overwrites outside the state the user confirmed. Unicode case
/// and NFC/NFD differences remain uncovered; those need a normalization
/// dependency the crate does not carry.
fn target_obstruction_paths(
    scope: &RepositoryScope,
    target_oid: &str,
    case_insensitive: bool,
) -> Result<BTreeSet<Vec<u8>>, String> {
    let target_tree = format!("{target_oid}^{{tree}}");
    let target_raw = run_scoped_git_stdout_raw(
        scope,
        &[
            "--no-replace-objects",
            "ls-tree",
            "-r",
            "-z",
            "--name-only",
            &target_tree,
        ],
    )?;
    let target_keys = target_raw
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| obstruction_key(path, case_insensitive))
        .collect::<Vec<_>>();
    // Deliberately omit `--exclude-standard`: ignored files are still untracked
    // and reset --hard overwrites them when the target tree tracks that path.
    let untracked_raw = run_scoped_git_stdout_raw(scope, &["ls-files", "--others", "-z"])?;
    let mut obstructions = BTreeSet::new();
    for untracked in untracked_raw
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        let untracked_key = obstruction_key(untracked, case_insensitive);
        if target_keys
            .iter()
            .any(|target_key| path_conflicts_with_reset_target(&untracked_key, target_key))
        {
            // Lease the path as git reported it — the key is only for matching.
            obstructions.insert(untracked.to_vec());
        }
    }
    Ok(obstructions)
}

fn capture_index_digest(repository: &Repository) -> Result<[u8; 32], String> {
    let index = repository
        .index()
        .map_err(|error| format!("Could not inspect the index before hard reset: {error}"))?;
    let mut state = Sha256::new();
    hash_field(&mut state, b"gitlane-hard-reset-index-v1");
    let mut count = 0u64;
    for entry in index.iter() {
        count += 1;
        let flags = IndexEntryFlag::from_bits_truncate(entry.flags);
        let extended = IndexEntryExtendedFlag::from_bits_truncate(entry.flags_extended);
        if flags.is_valid() {
            return Err(format!(
                "{} is marked assume-unchanged. Clear that index flag before hard reset.",
                String::from_utf8_lossy(&entry.path)
            ));
        }
        if extended.is_skip_worktree() {
            return Err(format!(
                "{} is marked skip-worktree (or belongs to a sparse index). Disable sparse/skip-worktree state before hard reset.",
                String::from_utf8_lossy(&entry.path)
            ));
        }
        let stage = ((entry.flags >> 12) & 0x3) as u8;
        if stage != 0 {
            return Err(
                "Conflicted index entries are present. Resolve or abort the operation before hard reset."
                    .to_string(),
            );
        }
        hash_field(&mut state, &entry.path);
        state.update(entry.id.as_bytes());
        state.update(entry.mode.to_le_bytes());
        state.update(entry.flags.to_le_bytes());
        state.update(entry.flags_extended.to_le_bytes());
    }
    state.update(count.to_le_bytes());
    Ok(state.finalize().into())
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
    let mut paths = BTreeSet::new();
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
        paths.insert(path);
        if let Some(other) = second {
            paths.insert(other);
        }
    }
    Ok(ParsedStatus {
        semantic_records,
        dirty_paths: paths,
    })
}

/// Fingerprint one leaf, returning the cheap pathname observation alongside it.
///
/// The observation is deliberately *not* part of the token — it carries inode
/// and timestamps, which guard **capture coherence** rather than content (see
/// `worktree_fs::WorktreeLeafObservation`). Hashing a set of files is not
/// atomic, so a leaf streamed early can be rewritten while later leaves are
/// still being read; its digest would then record the pre-edit bytes and the
/// token would still match. [`validate_observations`] closes that window.
fn fingerprint_with_budget(
    workdir: &Path,
    path: &OsStr,
    remaining_bytes: &mut u64,
) -> Result<(WorktreeLeafFingerprint, WorktreeLeafObservation), String> {
    let (fingerprint, observation) =
        fingerprint_worktree_leaf_path_bounded(workdir, Path::new(path), *remaining_bytes)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::InvalidData {
                    format!(
                        "Hard reset exceeded its {} MiB content-fingerprint limit while inspecting {}. Use the terminal for this unusually large repository state.",
                        MAX_FINGERPRINT_BYTES / (1024 * 1024),
                        path_label(path)
                    )
                } else {
                    format!(
                        "Could not inspect {} before hard reset: {error}",
                        path_label(path)
                    )
                }
            })?;
    if let WorktreeLeafFingerprint::Regular { len, .. } = &fingerprint {
        *remaining_bytes = remaining_bytes.checked_sub(*len).ok_or_else(|| {
            format!(
                "Hard reset exceeded its {} MiB content-fingerprint limit while inspecting {}. Use the terminal for this unusually large repository state.",
                MAX_FINGERPRINT_BYTES / (1024 * 1024),
                path_label(path)
            )
        })?;
    }
    Ok((fingerprint, observation))
}

/// Recheck every fingerprinted leaf's cheap metadata after the content pass.
///
/// Mirrors `discard_all`'s check of the same name, and runs at the same two
/// points: the end of the stable preview capture, and the mutation boundary. It
/// rereads no content, so almost no delay remains between it and the destructive
/// subprocess — that is the whole point (GL-302 review).
fn validate_observations(snapshot: &HardResetSnapshot) -> Result<(), String> {
    for (raw_path, observation) in &snapshot.observations {
        let path = git_path(raw_path)?;
        if !validate_worktree_leaf_observation_path(
            &snapshot.scope.workdir,
            Path::new(&path),
            observation,
        )
        .map_err(|error| {
            format!(
                "Could not recheck {} before hard reset: {error}",
                path_label(&path)
            )
        })? {
            return Err(STALE_MESSAGE.to_string());
        }
    }
    Ok(())
}

fn capture_once(repo: &str, target_oid: &str) -> Result<HardResetSnapshot, String> {
    let (repository, scope) = discover_scope(repo)?;
    ensure_no_replace_refs(&scope)?;
    let (expected_head_branch, expected_head_oid) = head_state(&repository)?;
    let expected_head_tree_oid = effective_head_tree_oid(&scope, expected_head_oid.as_deref())?;
    let target_tree_oid = effective_tree_oid_no_replace(&scope, target_oid)?;
    let index_digest = capture_index_digest(&repository)?;
    let ParsedStatus {
        semantic_records,
        dirty_paths,
    } = read_status(&scope)?;
    let case_insensitive = case_insensitive_paths(&repository);
    let obstruction_paths = target_obstruction_paths(&scope, target_oid, case_insensitive)?;

    let mut remaining_bytes = MAX_FINGERPRINT_BYTES;
    let mut fingerprints = BTreeMap::new();
    let mut observations = BTreeMap::new();
    for raw_path in dirty_paths.iter().chain(obstruction_paths.iter()) {
        if fingerprints.contains_key(raw_path) {
            continue;
        }
        let path = git_path(raw_path)?;
        let (fingerprint, observation) =
            fingerprint_with_budget(&scope.workdir, &path, &mut remaining_bytes)?;
        fingerprints.insert(raw_path.clone(), fingerprint);
        observations.insert(raw_path.clone(), observation);
    }
    run_after_fingerprint_test_hook();

    let mut full = Sha256::new();
    hash_field(&mut full, b"gitlane-hard-reset-v2");
    hash_os(&mut full, scope.workdir.as_os_str());
    hash_os(&mut full, scope.gitdir.as_os_str());
    hash_os(&mut full, scope.commondir.as_os_str());
    hash_identity(&mut full, &scope.workdir_identity);
    hash_identity(&mut full, &scope.gitdir_identity);
    hash_identity(&mut full, &scope.commondir_identity);
    full.update([u8::from(scope.is_worktree)]);
    // Flipping core.ignorecase changes which paths count as obstructions, so it
    // belongs in the token: the preview expires rather than silently leasing a
    // different set than the write would compute.
    full.update([u8::from(case_insensitive)]);
    match &expected_head_branch {
        Some(branch) => {
            full.update([1]);
            hash_field(&mut full, branch.as_bytes());
        }
        None => full.update([0]),
    }
    match &expected_head_oid {
        Some(oid) => {
            full.update([1]);
            hash_field(&mut full, oid.as_bytes());
        }
        None => full.update([0]),
    }
    match &expected_head_tree_oid {
        Some(oid) => {
            full.update([1]);
            hash_field(&mut full, oid.as_bytes());
        }
        None => full.update([0]),
    }
    hash_field(&mut full, target_tree_oid.as_bytes());
    full.update(index_digest);
    full.update((semantic_records.len() as u64).to_le_bytes());
    for record in &semantic_records {
        hash_field(&mut full, record);
    }
    full.update((obstruction_paths.len() as u64).to_le_bytes());
    for raw_path in &obstruction_paths {
        hash_field(&mut full, raw_path);
    }
    full.update((fingerprints.len() as u64).to_le_bytes());
    for (raw_path, fingerprint) in &fingerprints {
        hash_field(&mut full, raw_path);
        let label = String::from_utf8_lossy(raw_path);
        fingerprint_into(&mut full, fingerprint, &label)?;
    }
    hash_field(&mut full, target_oid.as_bytes());

    Ok(HardResetSnapshot {
        expected_state: format!("v2:{}", URL_SAFE_NO_PAD.encode(full.finalize())),
        expected_head_branch,
        expected_head_oid,
        target_oid: target_oid.to_string(),
        scope,
        observations,
    })
}

fn capture_stable(repo: &str, target_oid: &str) -> Result<HardResetSnapshot, String> {
    let initial = capture_once(repo, target_oid)?;
    run_capture_test_hook();
    let fresh = capture_once(repo, target_oid)?;
    if initial.expected_state != fresh.expected_state
        || initial.expected_head_branch != fresh.expected_head_branch
        || initial.expected_head_oid != fresh.expected_head_oid
        || initial.target_oid != fresh.target_oid
    {
        return Err(
            "The repository changed while GitLane was preparing the hard-reset preview. Try again."
                .to_string(),
        );
    }
    validate_observations(&fresh)?;
    Ok(fresh)
}

/// Capture the opaque exact-state lease shown by a hard-reset confirmation.
pub(super) fn capture(
    repo: &str,
    target_oid: &str,
) -> Result<(String, Option<String>, Option<String>), String> {
    let snapshot = capture_stable(repo, target_oid)?;
    Ok((
        snapshot.expected_state,
        snapshot.expected_head_branch,
        snapshot.expected_head_oid,
    ))
}

/// Untracked (including ignored) paths that may be deleted by `git reset --hard`
/// because they collide with the target tree — for the confirmation warning list.
/// Shares detection with the lease fingerprint so preview and execute cannot drift.
pub(super) fn preview_untracked_obstructions(
    repo: &str,
    target_oid: &str,
) -> Result<Vec<String>, String> {
    let (repository, scope) = discover_scope(repo)?;
    // Same folding as the lease, or the warning list and the fingerprinted set
    // would disagree on a case-insensitive checkout.
    let paths = target_obstruction_paths(&scope, target_oid, case_insensitive_paths(&repository))?;
    Ok(paths
        .into_iter()
        .take(16)
        .map(|path| format!("?? {}", String::from_utf8_lossy(&path)))
        .collect())
}

/// Hard reset leases the already-checked-out worktree. Reject a named source
/// that is not HEAD so preview cannot describe one branch while fingerprinting
/// another (GL-302 review).
pub(super) fn ensure_source_is_checked_out(repo: &str, source: &str) -> Result<(), String> {
    if source == "HEAD" {
        return Ok(());
    }
    match super::head::current_branch(repo) {
        Some(branch) if branch == source => Ok(()),
        _ => Err(format!(
            "Hard reset requires '{source}' to already be checked out. Check it out, then preview again."
        )),
    }
}

/// Re-capture and reject any drift immediately before `git reset --hard`.
/// Callers must finish tip/HEAD preparation first so this sits at the mutation
/// boundary (GL-302 review).
///
/// Only a *mismatch* proves the preview expired; a failed re-capture reports
/// [`UNVERIFIABLE_MESSAGE`] with the underlying cause instead, since it may be a
/// scope retarget (real drift) or an unreadable index (not drift at all).
///
/// Returns the [`ValidatedScope`] the check ran in — the caller must mutate
/// through it rather than through the repo path it started from.
pub(super) fn validate_at_mutation_boundary(
    repo: &str,
    target_oid: &str,
    expected_state: &str,
    expected_head_branch: Option<&str>,
    expected_head_oid: Option<&str>,
) -> Result<ValidatedScope, String> {
    let snapshot = capture_once(repo, target_oid)
        .map_err(|error| format!("{UNVERIFIABLE_MESSAGE} {error}"))?;
    if snapshot.expected_state != expected_state
        || snapshot.expected_head_branch.as_deref() != expected_head_branch
        || snapshot.expected_head_oid.as_deref() != expected_head_oid
        || snapshot.target_oid != target_oid
    {
        return Err(STALE_MESSAGE.to_string());
    }
    // Last, and deliberately cheap: rereads no content, so the gap between this
    // and `git reset --hard` stays as small as it can without a worktree lock.
    validate_observations(&snapshot)?;
    Ok(ValidatedScope(snapshot.scope))
}
