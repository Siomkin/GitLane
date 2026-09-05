use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::AppHandle;

use super::classification::{handle_event, is_ignored, EmitState};
use super::commondir::{CommondirSubscriber, SharedWatch};
use super::roots::WatchRoots;
use super::WatcherState;

/// One open tab's private watch: its workdir, plus its private gitdir when that
/// lies outside the common dir. `commondir` records which shared watch this tab
/// is subscribed to, so closing it can detach the subscription.
pub(super) struct TabWatch {
    pub(super) _watcher: RecommendedWatcher,
    pub(super) commondir: Option<PathBuf>,
}

/// The watcher registry: one private watch per open tab, plus shared common-dir
/// watches keyed by canonical common-dir path.
#[derive(Default)]
pub(super) struct Watchers {
    pub(super) tabs: HashMap<String, TabWatch>,
    pub(super) shared: HashMap<PathBuf, SharedWatch>,
}

/// Build the tab's private watcher (workdir + private gitdir when outside the
/// common dir). Fallible: a `notify` create/registration error propagates.
pub(super) fn build_private_watcher(
    app: &AppHandle,
    key: &str,
    roots: &WatchRoots,
    fingerprint_root: &Path,
    emit: &Arc<Mutex<EmitState>>,
) -> Result<RecommendedWatcher, String> {
    let app = app.clone();
    let key = key.to_string();
    let event_roots = roots.clone();
    let event_fingerprint_root = fingerprint_root.to_path_buf();
    let emit = emit.clone();
    // Held open for the life of this watch so ignore checks don't re-open the
    // repo per event (libgit2 revalidates cached ignore files by filestamp, so
    // `.gitignore` edits are picked up). `git2::Repository` is `Send` but not
    // `Sync`, so it stays owned by this single closure — never shared with the
    // common-dir watcher (whose paths never consult ignore rules) — and never
    // crosses the async command boundary.
    let ignore_repo = git2::Repository::discover(fingerprint_root).ok();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        handle_event(
            &app,
            &key,
            &event_roots,
            &event_fingerprint_root,
            |relative| is_ignored(ignore_repo.as_ref(), relative),
            &emit,
            &event,
        );
    })
    .map_err(|e| format!("failed to create watcher: {e}"))?;
    for target in roots.private_targets() {
        watcher
            .watch(target, RecursiveMode::Recursive)
            .map_err(|e| format!("failed to watch {}: {e}", target.display()))?;
    }
    Ok(watcher)
}

/// This tab's subscription to a shared common-dir watch.
fn make_subscriber(
    roots: &WatchRoots,
    fingerprint_root: &Path,
    emit: &Arc<Mutex<EmitState>>,
) -> CommondirSubscriber {
    CommondirSubscriber {
        roots: roots.clone(),
        fingerprint_root: fingerprint_root.to_path_buf(),
        emit: emit.clone(),
    }
}

/// Register (or replace) a tab's watch in the registry, given its already-built
/// private watcher and a factory for the shared common-dir watch.
///
/// Ordering is the crux (GL-125 review): the previously-registered watch for
/// `key` must not be dropped until its replacement is fully in place. So every
/// fallible step — building a fresh shared common-dir watch when one is needed —
/// runs *before* `detach`, and once past `detach` there is no early return. A
/// notify failure therefore leaves the previous watch intact (the caller's
/// best-effort `watchRepo` swallows the error and the tab stays watched) rather
/// than stranding the tab unwatched for the session.
pub(super) fn install_watch(
    state: &WatcherState,
    key: String,
    roots: &WatchRoots,
    fingerprint_root: &Path,
    emit: Arc<Mutex<EmitState>>,
    private_watcher: RecommendedWatcher,
    spawn_shared: impl FnOnce(
        &Path,
        Arc<Mutex<HashMap<String, CommondirSubscriber>>>,
    ) -> Result<RecommendedWatcher, String>,
) -> Result<(), String> {
    let commondir = roots.commondir.clone();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;

    // Stage the only fallible registry step — creating a fresh shared watch —
    // before detaching the old watch. A shared watch is only needed anew when it
    // won't survive detaching this key (no other tab subscribes to it);
    // otherwise this tab just joins the surviving one, which is infallible.
    let staged_shared = match &commondir {
        Some(common) => {
            let survives = guard.shared.get(common).is_some_and(|shared| {
                shared
                    .subscribers
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .keys()
                    .any(|other| other != &key)
            });
            if survives {
                None
            } else {
                let subscribers = Arc::new(Mutex::new(HashMap::new()));
                subscribers
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(key.clone(), make_subscriber(roots, fingerprint_root, &emit));
                // Fallible — a failure here returns with the old watch intact.
                let watcher = spawn_shared(common, subscribers.clone())?;
                Some(SharedWatch {
                    _watcher: watcher,
                    subscribers,
                })
            }
        }
        None => None,
    };

    // Everything fallible has succeeded — commit. No early return past here, so
    // the old watch can never be dropped without its replacement in place.
    detach(&mut guard, &key);
    if let Some(common) = &commondir {
        match staged_shared {
            Some(shared) => {
                guard.shared.insert(common.clone(), shared);
            }
            // The existing shared watch survived detach; join it.
            None => {
                if let Some(shared) = guard.shared.get(common) {
                    shared
                        .subscribers
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .insert(key.clone(), make_subscriber(roots, fingerprint_root, &emit));
                }
            }
        }
    }
    guard.tabs.insert(
        key,
        TabWatch {
            _watcher: private_watcher,
            commondir,
        },
    );
    Ok(())
}

/// Remove a tab's private watch and unsubscribe it from its shared common-dir
/// watch, tearing that shared watch down once its last subscriber leaves.
pub(super) fn detach(watchers: &mut Watchers, key: &str) {
    let Some(tab) = watchers.tabs.remove(key) else {
        return;
    };
    let Some(common) = tab.commondir else {
        return;
    };
    let empty = match watchers.shared.get(&common) {
        Some(shared) => {
            // A poisoned subscriber lock still means teardown is safer than a
            // leaked watch, so recover the map either way.
            let mut subscribers = shared
                .subscribers
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            subscribers.remove(key);
            subscribers.is_empty()
        }
        None => false,
    };
    if empty {
        watchers.shared.remove(&common);
    }
}
