//! In-window stash extraction and graph-order injection inputs.

use std::collections::HashSet;

use git2::{Oid, Repository};

/// A stash whose base commit is inside the loaded window, ready to be injected
/// into the layout as a synthetic single-parent node (`oid` waiting on `base`).
pub(super) struct StashMeta {
    pub(super) oid: Oid,
    pub(super) base: Oid,
    pub(super) timestamp: i64,
    pub(super) index: usize,
    pub(super) message: String,
}

/// One node in the merged, date-ordered layout sequence: either a real commit
/// (by oid — the handle is re-opened once in the layout loop, a cheap ODB-cache
/// hit, so we don't retain every `git2::Commit` for the whole window) or an
/// injected in-window stash.
pub(super) enum Entry<'a> {
    Commit(Oid),
    Stash(&'a StashMeta),
}

/// Read the stash reflog (`refs/stash`) via libgit2 and keep only the stashes
/// whose base (first parent) is inside `visible_oids`, so they can be laid out
/// inline. Out-of-window stashes are left to the frontend, which floats them by
/// time or rejoins them through a bounded context chain. Reading here (read side,
/// git2) keeps the graph self-contained and avoids coupling the skeleton to the
/// slower `git stash list` subprocess. Returns newest-first with the reflog index
/// preserved as the `stash@{index}` number.
pub(super) fn read_in_window_stashes(
    repo: &Repository,
    visible_oids: &HashSet<Oid>,
) -> Vec<StashMeta> {
    let Ok(reflog) = repo.reflog("refs/stash") else {
        return Vec::new();
    };
    let mut metas = Vec::new();
    for (index, entry) in reflog.iter().enumerate() {
        let oid = entry.id_new();
        // If the stash commit itself is already in the revwalk (e.g. HEAD detached
        // at it, or otherwise reachable from a tip), it's laid out as a normal
        // commit — injecting it too would emit a duplicate node with the same id.
        if visible_oids.contains(&oid) {
            continue;
        }
        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };
        let Some(base) = commit.parent_ids().next() else {
            continue;
        };
        if !visible_oids.contains(&base) {
            continue;
        }
        metas.push(StashMeta {
            oid,
            base,
            timestamp: commit.time().seconds(),
            index,
            message: commit
                .summary_bytes()
                .map(|b| String::from_utf8_lossy(b).into_owned())
                .unwrap_or_default(),
        });
    }
    // Date-descending so the merge-interleave below can slot each stash in with a
    // single forward scan; the reflog index travels along as `stash@{index}`.
    metas.sort_by_key(|meta| std::cmp::Reverse(meta.timestamp));
    metas
}
