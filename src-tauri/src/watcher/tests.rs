use super::classification::{ChangeKind, EmitState};
use super::commondir::{CommondirSubscriber, SharedWatch};
use super::install::{detach, install_watch, TabWatch, Watchers};
use super::roots::{resolve_watch_roots, WatchRoots};
use super::WatcherState;
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
