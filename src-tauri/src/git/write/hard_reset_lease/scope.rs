//! Resolving and holding the repository scope a hard reset is leased over,
//! and the shared-lease failures rendered in this operation's words.

use std::ffi::OsString;

use git2::Repository;
use sha2::Sha256;

use crate::git::worktree_fs::WorktreeLeafFingerprint;

use super::super::cli::run_git_scoped_os;
use super::super::state_lease::{self, scoped_git_args, LeaseError, RepositoryScope};

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

/// Render a shared-primitive failure in this operation's own words.
pub(in crate::git::write) fn describe_lease_error(error: LeaseError) -> String {
    match error {
        LeaseError::WorkdirNotUtf8 => {
            "Cannot lease a hard reset from a worktree path that is not valid UTF-8.".to_string()
        }
        LeaseError::OpenRepository(error) => format!("Could not inspect the repository before hard reset: {error}"),
        LeaseError::BareRepository => "Cannot hard-reset a bare repository.".to_string(),
        LeaseError::NonUtf8GitPath => "Hard reset cannot safely represent a non-UTF-8 Git path on this platform.".to_string(),
        LeaseError::ReplaceRefsActive => "Hard reset is unavailable while Git replacement refs are active. Remove the replacement refs or use the terminal.".to_string(),
        LeaseError::InspectHead(error) => format!("Could not inspect HEAD before hard reset: {error}"),
        LeaseError::ResolveHead(error) => format!("Could not resolve HEAD before hard reset: {error}"),
        LeaseError::NonFileWorktreePath { label, kind, mode } => {
            format!("Refusing to hard-reset while non-file worktree path {label} is present (type {kind}, mode {mode:o}). Move it aside and try again.")
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

/// A repository scope proved current by [`validate_at_mutation_boundary`].
///
/// Validation resolves and checks one canonical gitdir/workdir pair, but a
/// caller that then shells out via the original repo *path* lets git re-discover
/// the scope — and a `.git`-file or linked-worktree retarget in that window
/// would point the reset somewhere the lease never covered. Holding the proved
/// scope in a value the mutation must go through closes that window by
/// construction rather than by comment (GL-302 review).
pub(in crate::git::write) struct ValidatedScope(pub(super) RepositoryScope);

impl ValidatedScope {
    /// Run a git subcommand pinned to the validated `--git-dir`/`--work-tree`.
    pub(in crate::git::write) fn run(&self, args: &[&str]) -> Result<String, String> {
        run_git_scoped_os(
            command_repo(&self.0)?,
            self.0.commondir.as_os_str(),
            &scoped_git_args(&self.0, args),
        )
    }
}
