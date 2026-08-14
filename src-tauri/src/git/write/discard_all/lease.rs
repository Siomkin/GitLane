//! Thin wrappers over `state_lease` that map failures through
//! [`describe_lease_error`].

use std::ffi::OsString;

use git2::Repository;
use sha2::Sha256;

use crate::git::worktree_fs::WorktreeLeafFingerprint;

use super::super::state_lease::{self, LeaseError, RepositoryScope};

/// Render a shared-primitive failure in this operation's own words.
pub(in crate::git::write) fn describe_lease_error(error: LeaseError) -> String {
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

pub(super) fn discover_scope(repo: &str) -> Result<(Repository, RepositoryScope), String> {
    state_lease::discover_scope(repo).map_err(describe_lease_error)
}

pub(super) fn git_path(bytes: &[u8]) -> Result<OsString, String> {
    state_lease::git_path(bytes).map_err(describe_lease_error)
}

pub(super) fn head_state(
    repository: &Repository,
) -> Result<(Option<String>, Option<String>), String> {
    state_lease::head_state(repository).map_err(describe_lease_error)
}

pub(super) fn ensure_no_replace_refs(scope: &RepositoryScope) -> Result<(), String> {
    state_lease::ensure_no_replace_refs(scope).map_err(describe_lease_error)
}

pub(super) fn fingerprint_into(
    state: &mut Sha256,
    fingerprint: &WorktreeLeafFingerprint,
    label: &str,
) -> Result<(), String> {
    state_lease::fingerprint_into(state, fingerprint, label).map_err(describe_lease_error)
}

pub(super) fn command_repo(scope: &RepositoryScope) -> Result<&str, String> {
    state_lease::command_repo(scope).map_err(describe_lease_error)
}

pub(super) fn run_scoped_git_stdout_raw(
    scope: &RepositoryScope,
    args: &[&str],
) -> Result<Vec<u8>, String> {
    state_lease::run_scoped_git_stdout_raw(scope, args).map_err(describe_lease_error)
}

pub(super) fn effective_head_tree_oid(
    scope: &RepositoryScope,
    head_oid: Option<&str>,
) -> Result<Option<String>, String> {
    state_lease::effective_head_tree_oid(scope, head_oid).map_err(describe_lease_error)
}
