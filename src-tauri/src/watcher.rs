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

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use std::{path::Path, path::PathBuf};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::AppHandle;

mod classification;

pub(crate) use classification::ChangeKind;
use classification::{graph_fingerprint, handle_event, is_ignored, EmitState, THROTTLE};

/// A worktree tab subscribed to a shared common-dir watch. Its roots and
/// fingerprint root drive classification from *this* tab's perspective (a
/// sibling worktree's HEAD move is graph-worthy here — the worktree list shows
/// its branch), and its `emit` is the same state its private watcher mutates.
struct CommondirSubscriber {
    roots: WatchRoots,
    fingerprint_root: PathBuf,
    emit: Arc<Mutex<EmitState>>,
}

/// One recursive watch on a repository's common dir (`<main>/.git`), fanned out
/// to every open worktree tab of that repository. Sharing a single watch avoids
/// the duplicate kernel/notify registration and the duplicate `repo-changed`
/// emissions two sibling worktree tabs would otherwise place on the same common
/// dir (GL-125).
struct SharedWatch {
    _watcher: RecommendedWatcher,
    subscribers: Arc<Mutex<HashMap<String, CommondirSubscriber>>>,
}

/// One open tab's private watch: its workdir, plus its private gitdir when that
/// lies outside the common dir. `commondir` records which shared watch this tab
/// is subscribed to, so closing it can detach the subscription.
struct TabWatch {
    _watcher: RecommendedWatcher,
    commondir: Option<PathBuf>,
}

/// The watcher registry: one private watch per open tab, plus shared common-dir
/// watches keyed by canonical common-dir path.
#[derive(Default)]
struct Watchers {
    tabs: HashMap<String, TabWatch>,
    shared: HashMap<PathBuf, SharedWatch>,
}

/// Filesystem watches for the open repositories. Adding a tab (`watch`) inserts
/// a private watch and subscribes it to the repository's shared common-dir
/// watch; removing it (`unwatch`, or re-inserting the key on reload) drops the
/// private watch and unsubscribes, tearing the shared watch down once its last
/// subscriber leaves. Background tabs keep their watches so their events keep
/// flowing.
#[derive(Clone, Default)]
pub struct WatcherState(Arc<Mutex<Watchers>>);

/// The filesystem roots one repository's watch must cover, resolved once at
/// watch time. For a plain checkout the workdir alone contains `.git`; for a
/// linked worktree the private gitdir and the shared common dir lie outside it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct WatchRoots {
    /// The worktree root (or the gitdir for a bare repo) — the opened path.
    workdir: PathBuf,
    /// This worktree's private gitdir (`<common>/worktrees/<name>` — HEAD,
    /// index, MERGE_HEAD, rebase state) when it lies outside `workdir`.
    gitdir: Option<PathBuf>,
    /// The shared common dir (`<main>/.git` — refs, objects, packed-refs)
    /// when it lies outside `workdir`.
    commondir: Option<PathBuf>,
}

impl WatchRoots {
    /// A plain checkout whose `.git` lives inside the workdir.
    fn plain(workdir: impl Into<PathBuf>) -> Self {
        WatchRoots {
            workdir: workdir.into(),
            gitdir: None,
            commondir: None,
        }
    }

    /// The directories this tab watches on its own — the workdir, plus its
    /// private gitdir when that lies *outside* the common dir. The private
    /// gitdir usually sits inside the common dir (`<common>/worktrees/<name>`),
    /// where the shared common-dir watch already covers it; it gets its own
    /// watch only in the unusual case where it lies elsewhere. The common dir
    /// (`commondir`) is watched once per repository and fanned out to every
    /// worktree tab (GL-125), so it is deliberately not included here.
    fn private_targets(&self) -> Vec<&Path> {
        let mut targets = vec![self.workdir.as_path()];
        if let Some(gitdir) = &self.gitdir {
            let covered = self
                .commondir
                .as_ref()
                .is_some_and(|common| gitdir.starts_with(common));
            if !covered {
                targets.push(gitdir);
            }
        }
        targets
    }
}

/// Resolve the roots a watch on `open_path` must cover. Paths come from the
/// same libgit2 handle so containment checks compare a consistent family; a
/// discovery failure degrades to watching just the opened directory (matching
/// the pre-worktree behaviour, and `classify_paths` stays conservative).
fn resolve_watch_roots(open_path: &Path) -> WatchRoots {
    let Ok(repo) = git2::Repository::discover(open_path) else {
        return WatchRoots::plain(open_path);
    };
    let workdir = repo
        .workdir()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| open_path.to_path_buf());
    let outside = |dir: &Path| !dir.starts_with(&workdir);
    WatchRoots {
        gitdir: Some(repo.path().to_path_buf()).filter(|p| outside(p)),
        commondir: Some(repo.commondir().to_path_buf()).filter(|p| outside(p)),
        workdir,
    }
}

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

/// Build the tab's private watcher (workdir + private gitdir when outside the
/// common dir). Fallible: a `notify` create/registration error propagates.
fn build_private_watcher(
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

/// Create the shared common-dir watcher: a single recursive watch that fans each
/// event out to every current subscriber, classified from that subscriber's own
/// perspective. Fallible: a `notify` create/registration error propagates.
fn spawn_commondir_watcher(
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
fn install_watch(
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

/// Stop watching `path` (tab closed). Dropping the private watch stops it;
/// unsubscribing from the shared common-dir watch drops that too once its last
/// subscriber leaves. Unknown paths are a no-op.
pub fn unwatch(state: &WatcherState, path: &str) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    detach(&mut guard, path);
    Ok(())
}

/// Remove a tab's private watch and unsubscribe it from its shared common-dir
/// watch, tearing that shared watch down once its last subscriber leaves.
fn detach(watchers: &mut Watchers, key: &str) {
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

#[cfg(test)]
mod tests {
    use super::{
        detach, install_watch, resolve_watch_roots, ChangeKind, CommondirSubscriber, EmitState,
        SharedWatch, TabWatch, WatchRoots, WatcherState, Watchers,
    };
    use notify::RecommendedWatcher;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    fn linked_worktree_roots() -> WatchRoots {
        WatchRoots {
            workdir: PathBuf::from("/wt"),
            gitdir: Some(PathBuf::from("/main/.git/worktrees/wt")),
            commondir: Some(PathBuf::from("/main/.git")),
        }
    }

    /// A no-op `notify` watcher that watches nothing — lets the subscription
    /// bookkeeping be tested without an `AppHandle` or real filesystem roots.
    fn dummy_watcher() -> RecommendedWatcher {
        notify::recommended_watcher(|_: notify::Result<notify::Event>| {}).expect("create watcher")
    }

    fn fresh_emit() -> Arc<Mutex<EmitState>> {
        Arc::new(Mutex::new(EmitState {
            last: Instant::now(),
            last_kind: ChangeKind::Worktree,
            last_graph_fingerprint: None,
        }))
    }

    /// GL-125 refcount lifecycle: two sibling worktree tabs share one common-dir
    /// watch; closing the first keeps it (the second still subscribes), and
    /// closing the last tears it — and the whole `shared` entry — down.
    #[test]
    fn shared_commondir_watch_is_refcounted_across_sibling_tabs() {
        let common = PathBuf::from("/main/.git");
        let subscribers = Arc::new(Mutex::new(HashMap::new()));
        for key in ["/wt1", "/wt2"] {
            subscribers.lock().unwrap().insert(
                key.to_string(),
                CommondirSubscriber {
                    roots: linked_worktree_roots(),
                    fingerprint_root: PathBuf::from(key),
                    emit: fresh_emit(),
                },
            );
        }
        let mut watchers = Watchers::default();
        watchers.shared.insert(
            common.clone(),
            SharedWatch {
                _watcher: dummy_watcher(),
                subscribers: subscribers.clone(),
            },
        );
        for key in ["/wt1", "/wt2"] {
            watchers.tabs.insert(
                key.to_string(),
                TabWatch {
                    _watcher: dummy_watcher(),
                    commondir: Some(common.clone()),
                },
            );
        }

        // Closing the first sibling: the shared watch survives for the second.
        detach(&mut watchers, "/wt1");
        assert!(watchers.shared.contains_key(&common));
        assert_eq!(subscribers.lock().unwrap().len(), 1);
        assert!(!watchers.tabs.contains_key("/wt1"));

        // Closing the last sibling: the shared watch (and its entry) is dropped.
        detach(&mut watchers, "/wt2");
        assert!(!watchers.shared.contains_key(&common));
        assert!(watchers.tabs.is_empty());
    }

    /// Seed a `WatcherState` with an existing watch for `key` on `common`, as its
    /// sole subscriber — the reload-of-a-lone-worktree case, where re-watching
    /// must register a *fresh* shared watch (the old one is torn down by detach).
    fn seed_lone_worktree_watch(state: &WatcherState, key: &str, common: &Path) {
        let mut guard = state.0.lock().unwrap();
        let subscribers = Arc::new(Mutex::new(HashMap::new()));
        subscribers.lock().unwrap().insert(
            key.to_string(),
            CommondirSubscriber {
                roots: linked_worktree_roots(),
                fingerprint_root: PathBuf::from(key),
                emit: fresh_emit(),
            },
        );
        guard.shared.insert(
            common.to_path_buf(),
            SharedWatch {
                _watcher: dummy_watcher(),
                subscribers,
            },
        );
        guard.tabs.insert(
            key.to_string(),
            TabWatch {
                _watcher: dummy_watcher(),
                commondir: Some(common.to_path_buf()),
            },
        );
    }

    /// GL-125 review — the ordering fix: if the replacement shared common-dir
    /// registration fails while re-watching an already-watched worktree, the
    /// previous watch must survive (the tab stays watched) rather than being torn
    /// down first and left unwatched for the session.
    #[test]
    fn failed_shared_watch_registration_keeps_the_previous_watch() {
        let roots = linked_worktree_roots();
        let common = roots.commondir.clone().unwrap();
        let key = "/wt".to_string();
        let state = WatcherState::default();
        seed_lone_worktree_watch(&state, &key, &common);

        // Re-watch the same worktree, but the shared registration fails.
        let result = install_watch(
            &state,
            key.clone(),
            &roots,
            Path::new("/wt"),
            fresh_emit(),
            dummy_watcher(),
            |_common, _subs| Err::<RecommendedWatcher, String>("boom".into()),
        );

        assert!(result.is_err(), "a failed shared registration must surface");
        let guard = state.0.lock().unwrap();
        assert!(
            guard.tabs.contains_key(&key),
            "the previous private watch must survive a failed re-watch"
        );
        assert!(
            guard.shared.contains_key(&common),
            "the previous shared watch must survive"
        );
        assert_eq!(
            guard
                .shared
                .get(&common)
                .unwrap()
                .subscribers
                .lock()
                .unwrap()
                .len(),
            1,
            "the sole subscriber is still registered"
        );
    }

    /// The success path of the same reload: the fresh shared watch swaps in and
    /// the tab stays registered.
    #[test]
    fn successful_rewatch_swaps_the_shared_watch_in_place() {
        let roots = linked_worktree_roots();
        let common = roots.commondir.clone().unwrap();
        let key = "/wt".to_string();
        let state = WatcherState::default();
        seed_lone_worktree_watch(&state, &key, &common);

        let result = install_watch(
            &state,
            key.clone(),
            &roots,
            Path::new("/wt"),
            fresh_emit(),
            dummy_watcher(),
            |_common, _subs| Ok(dummy_watcher()),
        );

        assert!(result.is_ok());
        let guard = state.0.lock().unwrap();
        assert!(guard.tabs.contains_key(&key));
        assert!(guard.shared.contains_key(&common));
        assert_eq!(
            guard
                .shared
                .get(&common)
                .unwrap()
                .subscribers
                .lock()
                .unwrap()
                .len(),
            1
        );
    }

    /// A plain (non-worktree) tab has no common dir, so `detach` just drops its
    /// private watch and never touches the shared map.
    #[test]
    fn detaching_a_plain_tab_leaves_shared_watches_untouched() {
        let mut watchers = Watchers::default();
        watchers.tabs.insert(
            "/repo".to_string(),
            TabWatch {
                _watcher: dummy_watcher(),
                commondir: None,
            },
        );
        detach(&mut watchers, "/repo");
        assert!(watchers.tabs.is_empty());
        assert!(watchers.shared.is_empty());
        // Detaching an unknown key is a no-op.
        detach(&mut watchers, "/nope");
    }

    /// The path-resolution helper (gitfile → private gitdir + commondir), on a
    /// real repository pair: the linked worktree needs the main `.git` watched;
    /// the main checkout needs nothing beyond its workdir.
    #[test]
    fn watch_roots_resolve_the_linked_worktree_gitdirs() {
        let base = std::env::temp_dir().join(format!("gitlane-watch-roots-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("main")).expect("create dirs");
        // FSEvents/libgit2 return real paths; keep the expectation family
        // consistent on macOS where /tmp and /var are symlinks.
        let base = base.canonicalize().expect("canonicalize base");
        let main_dir = base.join("main");
        let repo = git2::Repository::init(&main_dir).expect("init repo");

        // A worktree needs a commit to branch from.
        {
            let mut index = repo.index().expect("index");
            let tree = index
                .write_tree()
                .and_then(|oid| repo.find_tree(oid))
                .expect("empty tree");
            let sig = git2::Signature::now("t", "t@example.com").expect("sig");
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .expect("initial commit");
        }

        let wt_dir = base.join("wt");
        repo.worktree("wt", &wt_dir, None).expect("add worktree");

        // The main checkout: everything lives under the workdir, so it watches
        // only its workdir privately and subscribes to no shared common dir.
        let roots = resolve_watch_roots(&main_dir);
        assert_eq!(roots.gitdir, None);
        assert_eq!(roots.commondir, None);
        assert_eq!(roots.private_targets(), vec![roots.workdir.as_path()]);

        // The linked worktree: private gitdir + shared common dir. The gitdir
        // nests inside the common dir, so the tab's *private* watch is just its
        // workdir; the common dir is watched once and shared (GL-125).
        let roots = resolve_watch_roots(&wt_dir);
        let gitdir = roots.gitdir.clone().expect("private gitdir resolved");
        let commondir = roots.commondir.clone().expect("commondir resolved");
        assert!(
            gitdir.ends_with("worktrees/wt"),
            "gitdir {gitdir:?} should be the private worktree dir"
        );
        assert!(
            gitdir.starts_with(&commondir),
            "private gitdir {gitdir:?} nests inside commondir {commondir:?}"
        );
        assert_eq!(roots.private_targets(), vec![roots.workdir.as_path()]);

        drop(repo);
        let _ = std::fs::remove_dir_all(&base);
    }
}
