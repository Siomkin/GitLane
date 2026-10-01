//! One in-process mutex per repository common directory.
//!
//! The index, identity and stash locks all serialize by `commondir`, so linked
//! worktrees of one repository share a lock while unrelated repositories stay
//! independent. Each mutex is leaked once and lives for the process lifetime,
//! just like the registry that owns its key.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

/// A registry of per-commondir mutexes; each lock kind owns one `static`.
pub(super) type CommondirLocks = OnceLock<Mutex<HashMap<PathBuf, &'static Mutex<()>>>>;

/// Take `repo`'s lock from `registry`; `what` names it in a resolve failure.
///
/// Neither the registry nor any lock guards recoverable state — callers re-read
/// the repository after locking — so a panic while one is held recovers the
/// guard instead of disabling that kind of write until the app restarts.
pub(super) fn commondir_lock(
    registry: &'static CommondirLocks,
    repo: &str,
    what: &str,
) -> Result<MutexGuard<'static, ()>, String> {
    let resolve_error = |error: &dyn std::fmt::Display| {
        format!("Failed to resolve the repository {what} lock: {error}")
    };
    let repository = git2::Repository::discover(repo).map_err(|error| resolve_error(&error))?;
    let common_dir = repository
        .commondir()
        .canonicalize()
        .map_err(|error| resolve_error(&error))?;
    let lock = *registry
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .entry(common_dir)
        .or_insert_with(|| Box::leak(Box::new(Mutex::new(()))));
    Ok(lock.lock().unwrap_or_else(PoisonError::into_inner))
}
