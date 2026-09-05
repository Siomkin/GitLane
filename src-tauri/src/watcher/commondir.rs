use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::AppHandle;

use super::classification::{handle_event, EmitState};
use super::roots::WatchRoots;

/// A worktree tab subscribed to a shared common-dir watch. Its roots and
/// fingerprint root drive classification from *this* tab's perspective (a
/// sibling worktree's HEAD move is graph-worthy here — the worktree list shows
/// its branch), and its `emit` is the same state its private watcher mutates.
pub(super) struct CommondirSubscriber {
    pub(super) roots: WatchRoots,
    pub(super) fingerprint_root: PathBuf,
    pub(super) emit: Arc<Mutex<EmitState>>,
}

/// One recursive watch on a repository's common dir (`<main>/.git`), fanned out
/// to every open worktree tab of that repository. Sharing a single watch avoids
/// the duplicate kernel/notify registration and the duplicate `repo-changed`
/// emissions two sibling worktree tabs would otherwise place on the same common
/// dir (GL-125).
pub(super) struct SharedWatch {
    pub(super) _watcher: RecommendedWatcher,
    pub(super) subscribers: Arc<Mutex<HashMap<String, CommondirSubscriber>>>,
}

/// Create the shared common-dir watcher: a single recursive watch that fans each
/// event out to every current subscriber, classified from that subscriber's own
/// perspective. Fallible: a `notify` create/registration error propagates.
pub(super) fn spawn_commondir_watcher(
    app: &AppHandle,
    common: &Path,
    subscribers: Arc<Mutex<HashMap<String, CommondirSubscriber>>>,
) -> Result<RecommendedWatcher, String> {
    let fan_app = app.clone();
    let fan_subscribers = subscribers;
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if event.kind.is_access() {
            return;
        }
        // Recover a poisoned lock rather than silencing every subscriber's
        // events until restart — consistent with `detach` (GL-125 review).
        let subscribers = fan_subscribers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for (sub_key, sub) in subscribers.iter() {
            // Common-dir paths never reach `classify_path`'s ignore branch
            // (that is workdir-only), so no repo handle is needed here.
            handle_event(
                &fan_app,
                sub_key,
                &sub.roots,
                &sub.fingerprint_root,
                |_| false,
                &sub.emit,
                &event,
            );
        }
    })
    .map_err(|e| format!("failed to create watcher: {e}"))?;
    watcher
        .watch(common, RecursiveMode::Recursive)
        .map_err(|e| format!("failed to watch {}: {e}", common.display()))?;
    Ok(watcher)
}
