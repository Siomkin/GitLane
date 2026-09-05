//! Filesystem watching for the open repositories.
//!
//! Watches each open worktree (recursively — includes `.git`, so commits,
//! checkouts, staging and file edits all register) and emits a classified
//! `repo-changed` Tauri event tagged with the open path. Worktree/index-only
//! events refresh status without rebuilding the graph; refs/HEAD/other git
//! metadata conservatively request a full sync.
//!
//! A *linked worktree*'s `.git` is a gitfile pointing at
//! `<main>/.git/worktrees/<name>/` — its HEAD, index, MERGE_HEAD and rebase
//! state live there, and the shared refs/objects live in `<main>/.git` — both
//! outside the worktree subtree. Those roots are resolved via libgit2 and
//! watched alongside the workdir (one watcher, multiple roots), so a terminal
//! checkout or a conflict started outside GitLane still fires `repo-changed`.
//!
//! macOS uses FSEvents (directory-level, cheap) so a recursive watch of the
//! worktree is affordable even with large `node_modules`/`target` trees. That
//! does not hold on Windows: `ReadDirectoryChangesW` reports *per-file* events,
//! so a `cargo build` or `bun install` floods the watcher with churn from
//! ignored directories, each event re-arming the throttle and driving a
//! redundant status re-sync. Paths covered by the repository's ignore rules
//! (`.gitignore` et al, via libgit2) and absent from the index are therefore
//! dropped before any throttle or fingerprint work — on every platform, since
//! untracked ignored files never affect status or the graph. (Force-added
//! files under ignored patterns stay in the index, so they keep refreshing.)
//! Bursts of the remaining events are throttled here and debounced again on
//! the frontend.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tauri::AppHandle;

mod classification;
mod commondir;
mod install;
mod roots;
#[cfg(test)]
mod tests;

pub(crate) use classification::ChangeKind;
use classification::{graph_fingerprint, EmitState, THROTTLE};
use commondir::spawn_commondir_watcher;
use install::{build_private_watcher, detach, install_watch, Watchers};
use roots::{resolve_watch_roots, WatchRoots};

/// Filesystem watches for the open repositories. Adding a tab (`watch`) inserts
/// a private watch and subscribes it to the repository's shared common-dir
/// watch; removing it (`unwatch`, or re-inserting the key on reload) drops the
/// private watch and unsubscribes, tearing the shared watch down once its last
/// subscriber leaves. Background tabs keep their watches so their events keep
/// flowing.
#[derive(Clone, Default)]
pub struct WatcherState(Arc<Mutex<Watchers>>);

pub fn watch(app: &AppHandle, state: &WatcherState, path: &str) -> Result<(), String> {
    let key = path.to_string();
    let roots = resolve_watch_roots(Path::new(path));
    // Fingerprint/ignore lookups discover from the workdir, exactly as events do.
    let fingerprint_root = roots.workdir.clone();
    let emit = Arc::new(Mutex::new(EmitState {
        last: Instant::now() - THROTTLE,
        last_kind: ChangeKind::Worktree,
        last_graph_fingerprint: graph_fingerprint(&fingerprint_root),
    }));

    // The tab's own watch: workdir plus its private gitdir when that lies
    // outside the common dir. Built before touching the registry, so its own
    // failure returns with the previous watch (if any) untouched.
    let private_watcher = build_private_watcher(app, &key, &roots, &fingerprint_root, &emit)?;

    // Install atomically: stage the (fallible) shared common-dir registration
    // before detaching the old watch, then commit. `spawn_commondir_watcher`
    // carries the app handle; the ordering/registry logic lives in
    // `install_watch`, which is app-free and unit-testable.
    install_watch(
        state,
        key,
        &roots,
        &fingerprint_root,
        emit,
        private_watcher,
        |common, subscribers| spawn_commondir_watcher(app, common, subscribers),
    )
}

/// Stop watching `path` (tab closed). Dropping the private watch stops it;
/// unsubscribing from the shared common-dir watch drops that too once its last
/// subscriber leaves. Unknown paths are a no-op.
pub fn unwatch(state: &WatcherState, path: &str) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    detach(&mut guard, path);
    Ok(())
}
