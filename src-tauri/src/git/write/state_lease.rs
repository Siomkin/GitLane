//! Primitives shared by the destructive-write state leases (GL-332).
//!
//! `discard_all` and `hard_reset_lease` both fingerprint repository state at
//! preview time and re-validate it immediately before mutating. The pattern was
//! established by the first and copied into the second, and the copies drifted —
//! most seriously when the hard-reset lease dropped the post-hashing observation
//! sweep and became able to destroy content the user never previewed (GL-302).
//!
//! What lives here is deliberately **policy-neutral and message-free**: each
//! operation keeps its own answer to which paths are affected, what it refuses,
//! and how it words that refusal. Anything phrased for the user stays in the
//! caller, so the shared core cannot quietly unify two different wordings.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

use git2::{Oid, Repository};
use sha2::{Digest, Sha256};

#[cfg(unix)]
use std::os::unix::ffi::{OsStrExt, OsStringExt};
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

use crate::git::worktree_fs::{
    worktree_directory_identity, WorktreeDirectoryIdentity, WorktreeLeafFingerprint,
};

use super::cli::run_git_scoped_os_stdout_raw;

/// A failure from a shared primitive, kept separate from how it is worded.
///
/// The two operations phrase the same failure differently, and not by swapping a
/// noun: `discard_all` says "Refusing to discard non-file worktree path X … Move
/// the directory or nested repository aside", hard reset says "Refusing to
/// hard-reset while X is present … Move it aside". A shared format string would
/// quietly unify two wordings, so anything operation-specific becomes a variant
/// the caller renders.
///
/// [`LeaseError::Worded`] is the escape hatch for text that is *already*
/// identical in both operations — that has one right phrasing, so it belongs
/// here rather than being duplicated into both callers.
#[derive(Debug)]
pub(super) enum LeaseError {
    /// The worktree path is not valid UTF-8, so it cannot be a command's cwd.
    WorkdirNotUtf8,
    /// The repository could not be opened.
    OpenRepository(git2::Error),
    /// The repository has no worktree.
    BareRepository,
    /// A git path cannot be represented on this platform. Constructed only on
    /// non-unix targets, where a path must round-trip through UTF-8; unix takes
    /// the raw bytes and never fails.
    #[cfg_attr(unix, allow(dead_code))]
    NonUtf8GitPath,
    /// `refs/replace/` entries are present, which would let the operation act on
    /// a different object graph than the one previewed.
    ReplaceRefsActive,
    /// HEAD could not be read.
    InspectHead(git2::Error),
    /// HEAD could not be resolved to a commit.
    ResolveHead(git2::Error),
    /// A path that must be a regular file, symlink, or absent is something else
    /// — a directory or nested repository the operation refuses to touch.
    NonFileWorktreePath { label: String, kind: u8, mode: u64 },
    /// Carries text that is the same for every operation.
    Worded(String),
}

/// Ceiling on the bytes one capture will hash before refusing to continue, so a
/// pathological worktree cannot stall a destructive confirmation indefinitely.
pub(super) const MAX_FINGERPRINT_BYTES: u64 = 256 * 1024 * 1024;

/// The filesystem incarnation a lease was taken against.
///
/// Paths alone are not enough: `WorktreeDirectoryIdentity` is what distinguishes
/// a directory recreated at the same pathname from the one the preview
/// inspected, which is how the close/reopen ABA case is caught. It pairs
/// device/inode with creation time, because an inode number on its own is
/// reusable and routinely is reused by a recreate at the same path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct RepositoryScope {
    pub(super) workdir: PathBuf,
    pub(super) gitdir: PathBuf,
    pub(super) commondir: PathBuf,
    pub(super) workdir_identity: WorktreeDirectoryIdentity,
    pub(super) gitdir_identity: WorktreeDirectoryIdentity,
    pub(super) commondir_identity: WorktreeDirectoryIdentity,
    pub(super) is_worktree: bool,
}

/// Pin a git invocation to a captured scope with explicit `--git-dir` and
/// `--work-tree`, so it cannot be redirected by a `.git`-file retarget between
/// validation and launch (GL-302).
pub(super) fn scoped_git_args(scope: &RepositoryScope, args: &[&str]) -> Vec<OsString> {
    let mut scoped = Vec::with_capacity(args.len() + 4);
    scoped.push(OsString::from("--git-dir"));
    scoped.push(scope.gitdir.as_os_str().to_os_string());
    scoped.push(OsString::from("--work-tree"));
    scoped.push(scope.workdir.as_os_str().to_os_string());
    scoped.extend(args.iter().map(OsString::from));
    scoped
}

/// Length-prefix before hashing, so no combination of field values can be
/// rearranged into the same digest by moving a separator.
///
/// This and [`os_bytes`] are the single definition of the two encodings every
/// lease token in `git::` shares, re-exported at `crate::git` for the one
/// non-lease consumer (`file_state`) — see GL-376.
pub(in crate::git) fn hash_field(state: &mut Sha256, bytes: &[u8]) {
    state.update((bytes.len() as u64).to_le_bytes());
    state.update(bytes);
}

#[cfg(unix)]
pub(in crate::git) fn os_bytes(value: &OsStr) -> Vec<u8> {
    value.as_bytes().to_vec()
}

#[cfg(windows)]
pub(in crate::git) fn os_bytes(value: &OsStr) -> Vec<u8> {
    value.encode_wide().flat_map(u16::to_le_bytes).collect()
}

#[cfg(not(any(unix, windows)))]
pub(in crate::git) fn os_bytes(value: &OsStr) -> Vec<u8> {
    value.to_string_lossy().as_bytes().to_vec()
}

pub(super) fn hash_os(state: &mut Sha256, value: &OsStr) {
    hash_field(state, &os_bytes(value));
}

/// Lossy rendering of a path, for embedding in a message. Lossy is acceptable
/// here precisely because the result is never hashed or compared — only shown.
pub(super) fn path_label(path: &OsStr) -> String {
    path.to_string_lossy().into_owned()
}

/// Open the repository containing `repo` and capture its scope.
pub(super) fn discover_scope(repo: &str) -> Result<(Repository, RepositoryScope), LeaseError> {
    let repository = Repository::discover(repo).map_err(LeaseError::OpenRepository)?;
    let workdir = repository
        .workdir()
        .ok_or(LeaseError::BareRepository)?
        .canonicalize()
        .map_err(|error| {
            LeaseError::Worded(format!(
                "Could not resolve the repository worktree: {error}"
            ))
        })?;
    let gitdir = repository.path().canonicalize().map_err(|error| {
        LeaseError::Worded(format!(
            "Could not resolve the repository metadata directory: {error}"
        ))
    })?;
    let commondir = repository.commondir().canonicalize().map_err(|error| {
        LeaseError::Worded(format!(
            "Could not resolve the repository common metadata directory: {error}"
        ))
    })?;
    let workdir_identity = worktree_directory_identity(&workdir).map_err(|error| {
        LeaseError::Worded(format!(
            "Could not identify the repository worktree: {error}"
        ))
    })?;
    let gitdir_identity = worktree_directory_identity(&gitdir).map_err(|error| {
        LeaseError::Worded(format!(
            "Could not identify the repository metadata directory: {error}"
        ))
    })?;
    let commondir_identity = worktree_directory_identity(&commondir).map_err(|error| {
        LeaseError::Worded(format!(
            "Could not identify the repository common metadata directory: {error}"
        ))
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

/// A raw git path as an `OsString`. Bytes pass through untouched on unix, where
/// a path need not be UTF-8 at all.
pub(super) fn git_path(bytes: &[u8]) -> Result<OsString, LeaseError> {
    #[cfg(unix)]
    {
        Ok(OsString::from_vec(bytes.to_vec()))
    }
    #[cfg(not(unix))]
    {
        String::from_utf8(bytes.to_vec())
            .map(OsString::from)
            .map_err(|_| LeaseError::NonUtf8GitPath)
    }
}

/// Read HEAD's branch name and resolved oid, tolerating an unborn branch.
pub(super) fn head_state(
    repository: &Repository,
) -> Result<(Option<String>, Option<String>), LeaseError> {
    let head = repository
        .find_reference("HEAD")
        .map_err(LeaseError::InspectHead)?;
    let branch = match head.symbolic_target_bytes() {
        Some(target) => {
            let name = target.strip_prefix(b"refs/heads/").ok_or_else(|| {
                LeaseError::Worded(
                    "HEAD points outside refs/heads; use the terminal for this repository state."
                        .to_string(),
                )
            })?;
            Some(
                std::str::from_utf8(name)
                    .map_err(|_| LeaseError::Worded("HEAD branch is not valid UTF-8.".to_string()))?
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
        Err(error) => return Err(LeaseError::ResolveHead(error)),
    };
    Ok((branch, oid))
}

/// Refuse to proceed while `refs/replace/` entries exist: they can silently
/// substitute one object for another, so the tree acted on need not be the tree
/// previewed.
pub(super) fn ensure_no_replace_refs(scope: &RepositoryScope) -> Result<(), LeaseError> {
    let refs = run_scoped_git_stdout_raw(
        scope,
        &["for-each-ref", "--format=%(refname)", "refs/replace/"],
    )?;
    if refs.iter().any(|byte| !byte.is_ascii_whitespace()) {
        return Err(LeaseError::ReplaceRefsActive);
    }
    Ok(())
}

/// Fold one leaf fingerprint into the running digest.
///
/// A non-file leaf is refused rather than hashed: a directory or nested
/// repository standing where a file is expected is not something a destructive
/// operation should silently traverse.
pub(super) fn fingerprint_into(
    state: &mut Sha256,
    fingerprint: &WorktreeLeafFingerprint,
    label: &str,
) -> Result<(), LeaseError> {
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
            return Err(LeaseError::NonFileWorktreePath {
                label: label.to_string(),
                kind: *kind,
                mode: *mode,
            });
        }
    }
    Ok(())
}

/// The worktree path as a `&str`, for use as a child process's working
/// directory.
pub(super) fn command_repo(scope: &RepositoryScope) -> Result<&str, LeaseError> {
    scope.workdir.to_str().ok_or(LeaseError::WorkdirNotUtf8)
}

/// Read raw stdout from a git invocation pinned to `scope`.
pub(super) fn run_scoped_git_stdout_raw(
    scope: &RepositoryScope,
    args: &[&str],
) -> Result<Vec<u8>, LeaseError> {
    run_git_scoped_os_stdout_raw(
        command_repo(scope)?,
        scope.commondir.as_os_str(),
        &scoped_git_args(scope, args),
    )
    .map_err(LeaseError::Worded)
}

/// Resolve HEAD's tree oid, ignoring replacement refs.
///
/// `--end-of-options` keeps a revision that looks like a flag from being parsed
/// as one, and the result is re-parsed as an `Oid` so a malformed line cannot
/// reach the digest.
pub(super) fn effective_head_tree_oid(
    scope: &RepositoryScope,
    head_oid: Option<&str>,
) -> Result<Option<String>, LeaseError> {
    let Some(head_oid) = head_oid else {
        return Ok(None);
    };
    let tree_spec = format!("{head_oid}^{{tree}}");
    let raw = run_scoped_git_stdout_raw(
        scope,
        &["rev-parse", "--verify", "--end-of-options", &tree_spec],
    )?;
    let text = std::str::from_utf8(&raw).map_err(|_| {
        LeaseError::Worded("Git returned a non-UTF-8 HEAD tree object id.".to_string())
    })?;
    let value = text.trim_end_matches(['\r', '\n']);
    if value.contains('\r') || value.contains('\n') {
        return Err(LeaseError::Worded(
            "Git returned a malformed HEAD tree object id.".to_string(),
        ));
    }
    let oid = Oid::from_str(value).map_err(|_| {
        LeaseError::Worded("Git returned a malformed HEAD tree object id.".to_string())
    })?;
    Ok(Some(oid.to_string()))
}
