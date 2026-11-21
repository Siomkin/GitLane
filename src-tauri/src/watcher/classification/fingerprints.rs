//! Cheap fingerprints that tell a real repository change from churn: the ref
//! set (for ambiguous events) and the index entries (for index-only events).
//!
//! Any tool's `git status` may rewrite `.git/index` just to save refreshed stat
//! data (file times, sizes). That rewrite changes nothing a status or graph
//! depends on, but the watcher sees the write. Hashing only what status reads —
//! each entry's path, object id, mode, stage and the flags that change how it
//! is compared — lets an index-only event be dropped when those are unchanged.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;

/// `GIT_INDEX_ENTRY_STAGEMASK | GIT_INDEX_ENTRY_VALID` (assume-unchanged).
const COMPARED_FLAGS: u16 = 0x3000 | 0x8000;
/// `GIT_INDEX_ENTRY_INTENT_TO_ADD | GIT_INDEX_ENTRY_SKIP_WORKTREE`.
const COMPARED_EXTENDED_FLAGS: u16 = (1 << 13) | (1 << 14);

/// Hash of the index entries a status depends on, leaving out stat data. `None`
/// when the repository or its index cannot be read.
pub(in crate::watcher) fn index_fingerprint(root: &Path) -> Option<u64> {
    let repo = git2::Repository::discover(root).ok()?;
    let index = repo.index().ok()?;
    let mut hasher = DefaultHasher::new();
    index.len().hash(&mut hasher);
    for entry in index.iter() {
        entry.path.hash(&mut hasher);
        entry.id.as_bytes().hash(&mut hasher);
        entry.mode.hash(&mut hasher);
        (entry.flags & COMPARED_FLAGS).hash(&mut hasher);
        (entry.flags_extended & COMPARED_EXTENDED_FLAGS).hash(&mut hasher);
    }
    Some(hasher.finish())
}

/// Whether an index-only event changed anything, recording the new fingerprint
/// when it did. An unreadable index counts as changed, so a refresh is never
/// lost to an error.
pub(super) fn index_entries_changed(previous: &mut Option<u64>, current: Option<u64>) -> bool {
    if current.is_some() && current == *previous {
        return false;
    }
    *previous = current;
    true
}

/// Hash of HEAD and every ref target, so an ambiguous event refreshes the graph
/// only when a ref actually moved.
pub(in crate::watcher) fn graph_fingerprint(root: &Path) -> Option<u64> {
    let repo = git2::Repository::discover(root).ok()?;
    let mut entries = Vec::new();
    if let Ok(references) = repo.references() {
        for reference in references.flatten() {
            let name = reference.name().ok().unwrap_or("");
            let target = reference
                .target()
                .map(|oid| oid.to_string())
                .or_else(|| {
                    reference
                        .symbolic_target()
                        .ok()
                        .flatten()
                        .map(str::to_string)
                })
                .unwrap_or_default();
            entries.push((name.to_string(), target));
        }
    }
    entries.sort_unstable();
    let mut hasher = DefaultHasher::new();
    entries.hash(&mut hasher);
    if let Ok(head) = repo.head() {
        head.name().ok().hash(&mut hasher);
        head.target().hash(&mut hasher);
        head.symbolic_target().ok().flatten().hash(&mut hasher);
    }
    Some(hasher.finish())
}
