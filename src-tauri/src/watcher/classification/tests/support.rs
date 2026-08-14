//! Shared fixtures for the classification tests.

use crate::watcher::WatchRoots;
use std::cell::Cell;
use std::path::{Path, PathBuf};

pub(super) fn paths(values: &[&str]) -> Vec<PathBuf> {
    values.iter().map(PathBuf::from).collect()
}

/// The roots of a linked worktree at `/wt` whose main checkout is `/main`.
pub(super) fn linked_worktree_roots() -> WatchRoots {
    WatchRoots {
        workdir: PathBuf::from("/wt"),
        gitdir: Some(PathBuf::from("/main/.git/worktrees/wt")),
        commondir: Some(PathBuf::from("/main/.git")),
    }
}

/// Ignore predicate for tests that exercise classification without a real
/// repository: nothing is ignored.
pub(super) fn none_ignored(_: &Path) -> bool {
    false
}

/// Stand-in for the repo's ignore rules in a typical GitLane-like project.
pub(super) fn build_dirs_ignored(relative: &Path) -> bool {
    relative.starts_with("node_modules") || relative.starts_with("src-tauri/target")
}

/// A fingerprint source that records how many times it was invoked, so the
/// laziness guarantee (no O(refs) hash on suppressed bursts) is testable.
pub(super) fn counting(value: Option<u64>, calls: &Cell<u32>) -> impl FnOnce() -> Option<u64> + '_ {
    move || {
        calls.set(calls.get() + 1);
        value
    }
}
