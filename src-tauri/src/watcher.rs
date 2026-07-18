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

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use std::{path::Path, path::PathBuf};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Mutable per-tab emission bookkeeping. A worktree tab's events arrive from
/// two watchers — its own workdir watcher and the shared common-dir watcher
/// that fans out to it (GL-125) — so this state is shared (`Arc<Mutex<_>>`) and
/// the throttle window / ref fingerprint coalesce events from both sources.
struct EmitState {
    /// When the last event was emitted, for the throttle window.
    last: Instant,
    /// The kind last emitted (a graph event can upgrade a worktree burst).
    last_kind: ChangeKind,
    /// The last ref/HEAD fingerprint, to tell a real ref move from noise.
    last_graph_fingerprint: Option<u64>,
}

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

/// Minimum gap between emitted events, to collapse the burst of fs events a
/// single git operation produces.
const THROTTLE: Duration = Duration::from_millis(300);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ChangeKind {
    Worktree,
    Graph,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PathImpact {
    Worktree,
    Graph,
    Ambiguous,
    /// Every path in the event is covered by the repo's ignore rules
    /// (e.g. `target/`, `node_modules/`) — never worth a re-sync.
    Ignored,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoChangedEvent {
    kind: ChangeKind,
    /// The open path this watch was started for (`summary.path`), so the
    /// frontend can route the event to the matching tab.
    path: String,
}

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

/// Classify one filesystem event for a single tab and emit `repo-changed` when
/// it warrants a re-sync. Shared by a tab's private (workdir) watcher and the
/// shared common-dir watcher's fan-out, so the tab's throttle/fingerprint state
/// (`state`) coalesces events from both sources into one window.
fn handle_event(
    app: &AppHandle,
    key: &str,
    roots: &WatchRoots,
    fingerprint_root: &Path,
    is_ignored: impl Fn(&Path) -> bool,
    state: &Mutex<EmitState>,
    event: &notify::Event,
) {
    // Ignore pure reads — only mutations should trigger a re-sync.
    if event.kind.is_access() {
        return;
    }
    let impact = classify_paths(roots, &event.paths, is_ignored);
    let Ok(mut st) = state.lock() else { return };
    let now = Instant::now();
    let throttled = now.duration_since(st.last) < THROTTLE;
    let last_kind = st.last_kind;
    // Pass a *lazy* fingerprint: `decide_emission` only hashes the ref set when
    // the decision actually depends on it, so a burst of `.git/refs` writes
    // (fetch/gc/rebase) hashes once instead of once per fs event.
    let Some(kind) = decide_emission(
        throttled,
        last_kind,
        impact,
        &mut st.last_graph_fingerprint,
        || graph_fingerprint(fingerprint_root),
    ) else {
        return;
    };
    st.last = now;
    st.last_kind = kind;
    // Release the lock before emitting so a sibling watcher isn't blocked on it
    // across the (foreign) event dispatch.
    drop(st);
    let _ = app.emit(
        "repo-changed",
        RepoChangedEvent {
            kind,
            path: key.to_string(),
        },
    );
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

fn classify_paths(
    roots: &WatchRoots,
    paths: &[PathBuf],
    is_ignored: impl Fn(&Path) -> bool,
) -> PathImpact {
    // An empty path list stays conservative (worktree refresh); an event whose
    // paths are all irrelevant churn is dropped outright.
    if paths.is_empty() {
        return PathImpact::Worktree;
    }
    let mut overall = PathImpact::Ignored;
    for path in paths {
        let impact = classify_path(roots, path, &is_ignored);
        if impact == PathImpact::Graph {
            return PathImpact::Graph;
        }
        overall = more_severe(overall, impact);
    }
    overall
}

/// The stronger of two impacts: Graph > Ambiguous > Worktree > Ignored.
/// Ambiguous outranks Worktree because the ref fingerprint can only upgrade
/// it — never lose the status refresh a Worktree path already earned.
fn more_severe(a: PathImpact, b: PathImpact) -> PathImpact {
    let rank = |impact: PathImpact| match impact {
        PathImpact::Ignored => 0,
        PathImpact::Worktree => 1,
        PathImpact::Ambiguous => 2,
        PathImpact::Graph => 3,
    };
    if rank(b) > rank(a) {
        b
    } else {
        a
    }
}

fn classify_path(
    roots: &WatchRoots,
    path: &Path,
    is_ignored: &impl Fn(&Path) -> bool,
) -> PathImpact {
    // Linked-worktree git roots first: the private gitdir nests inside the
    // common dir, so match the deepest root before its container.
    if let Some(gitdir) = &roots.gitdir {
        if let Ok(relative) = path.strip_prefix(gitdir) {
            return git_metadata_impact(relative);
        }
    }
    if let Some(common) = &roots.commondir {
        if let Ok(relative) = path.strip_prefix(common) {
            return commondir_impact(relative);
        }
    }
    let Ok(relative) = path.strip_prefix(&roots.workdir) else {
        // Outside every watched root — shouldn't happen; stay conservative.
        return PathImpact::Graph;
    };
    let mut components = relative.components();
    let Some(first) = components.next() else {
        // FSEvents can report only the watched directory. Compare a cheap
        // HEAD/ref fingerprint so ordinary file writes remain worktree-only
        // while commits, branch/tag changes, and stash refs still refresh
        // the graph.
        return PathImpact::Ambiguous;
    };
    if first.as_os_str() != ".git" {
        // Build/install churn in ignored trees (`target/`, `node_modules/`)
        // never changes status or the graph — skip it before it can count
        // toward a re-sync.
        if is_ignored(relative) {
            return PathImpact::Ignored;
        }
        return PathImpact::Worktree;
    }
    git_metadata_impact(components.as_path())
}

/// A path inside this worktree's own git metadata (`.git/…` of a plain
/// checkout, or the private gitdir of a linked worktree): index churn only
/// needs a status refresh; HEAD/refs/merge/rebase state rebuild the graph,
/// as does an event naming the metadata dir itself.
fn git_metadata_impact(relative: &Path) -> PathImpact {
    let Some(first) = relative.components().next() else {
        return PathImpact::Graph;
    };
    let name = first.as_os_str().to_string_lossy();
    if name == "index" || name == "index.lock" || name == "COMMIT_EDITMSG" {
        PathImpact::Worktree
    } else {
        PathImpact::Graph
    }
}

/// A path inside the shared common dir of a *linked* worktree (this root only
/// exists then; the open worktree's own gitdir was matched before it).
fn commondir_impact(relative: &Path) -> PathImpact {
    let mut components = relative.components();
    let Some(first) = components.next() else {
        // The common dir itself (directory-level event): refs may have moved —
        // let the ref fingerprint decide.
        return PathImpact::Ambiguous;
    };
    match first.as_os_str().to_string_lossy().as_ref() {
        // Another worktree's private dir. Only its HEAD is visible in this
        // window (the worktree list shows each checkout's branch); its index /
        // merge / rebase state belongs to that checkout alone.
        "worktrees" => {
            let mut rest = components.skip(1); // skip <name>
            match rest.next() {
                Some(entry) if entry.as_os_str() == "HEAD" => PathImpact::Graph,
                Some(_) => PathImpact::Ignored,
                // `worktrees/` or `worktrees/<name>` itself (directory-level
                // event, or a worktree added/pruned): fingerprint decides.
                None => PathImpact::Ambiguous,
            }
        }
        // The main checkout's own working state — foreign to this window.
        "index" | "index.lock" | "COMMIT_EDITMSG" => PathImpact::Ignored,
        // Shared refs / packed-refs / objects / logs, the main checkout's HEAD
        // (worktree list), and unknown metadata: conservatively graph.
        _ => PathImpact::Graph,
    }
}

/// Whether a worktree-relative path is covered by the repository's ignore
/// rules *and* not tracked. libgit2's `is_path_ignored` implements
/// `git check-ignore --no-index` semantics — it applies ignore patterns even
/// to tracked files — but a force-added (`git add -f`) file under an ignored
/// pattern is still status-affecting, so any index presence (the path itself,
/// or for directory events any entry beneath it) fails open. The path is
/// re-joined with `/` separators because libgit2 matches ignore patterns
/// against slash-separated paths (Windows events arrive with `\`). Errors and
/// the no-repo case also fall back to "not ignored", so filtering can only
/// ever suppress noise, never a real change.
fn is_ignored(repo: Option<&git2::Repository>, relative: &Path) -> bool {
    let Some(repo) = repo else { return false };
    let mut normalized = String::new();
    for component in relative.components() {
        if !normalized.is_empty() {
            normalized.push('/');
        }
        normalized.push_str(&component.as_os_str().to_string_lossy());
    }
    if normalized.is_empty() {
        return false;
    }
    if !repo.is_path_ignored(&normalized).unwrap_or(false) {
        return false;
    }
    let Ok(mut index) = repo.index() else {
        return false;
    };
    // Soft reload so a `git add -f` after the watch started is seen; with
    // force=false this is filestamp-validated (a stat in the common case).
    if index.read(false).is_err() {
        return false;
    }
    !index_has_path_or_descendant(&index, &normalized)
}

/// Whether the index contains `path` itself (at any stage) or any entry under
/// `path/`. The index is sorted by raw path bytes, so both probes are binary
/// searches; `dir.txt` sorts between `dir` and `dir/`, which is why the
/// descendant probe needs its own search for the `dir/` prefix rather than
/// reusing the exact-path position.
fn index_has_path_or_descendant(index: &git2::Index, path: &str) -> bool {
    if let Some(entry) = first_entry_at_or_after(index, path.as_bytes()) {
        if entry.path == path.as_bytes() {
            return true;
        }
    }
    let prefix = format!("{path}/");
    first_entry_at_or_after(index, prefix.as_bytes())
        .is_some_and(|entry| entry.path.starts_with(prefix.as_bytes()))
}

/// First index entry whose path is byte-wise `>= target`, by binary search
/// over the sorted index (`Index::get` is random access by position).
fn first_entry_at_or_after(index: &git2::Index, target: &[u8]) -> Option<git2::IndexEntry> {
    let (mut low, mut high) = (0, index.len());
    while low < high {
        let mid = low + (high - low) / 2;
        let entry = index.get(mid)?;
        if entry.path.as_slice() < target {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    index.get(low)
}

fn resolve_change_kind(
    impact: PathImpact,
    previous_fingerprint: &mut Option<u64>,
    current_fingerprint: Option<u64>,
) -> ChangeKind {
    match impact {
        // Filtered out by `decide_emission` before kind resolution; mapped to
        // the mildest kind rather than panicking on the watcher thread.
        PathImpact::Ignored => ChangeKind::Worktree,
        PathImpact::Worktree => ChangeKind::Worktree,
        PathImpact::Graph => {
            *previous_fingerprint = current_fingerprint;
            ChangeKind::Graph
        }
        PathImpact::Ambiguous => match (*previous_fingerprint, current_fingerprint) {
            (Some(previous), Some(current)) if previous == current => ChangeKind::Worktree,
            (_, Some(current)) => {
                *previous_fingerprint = Some(current);
                ChangeKind::Graph
            }
            // If the repository cannot be inspected, preserve correctness.
            (_, None) => ChangeKind::Graph,
        },
    }
}

/// Decide whether a classified event should emit (and as what `ChangeKind`),
/// given the throttle window and the previously emitted kind. Returns `None`
/// when the event is suppressed and left to the frontend's trailing debounce.
///
/// `fingerprint` is invoked only when the decision needs to know whether refs
/// actually changed. Within the throttle window the common cases — a repeated
/// graph event, or any worktree event — are resolved from `impact` alone, so a
/// burst of ref writes never pays the O(refs) hash more than once.
fn decide_emission(
    throttled: bool,
    last_kind: ChangeKind,
    impact: PathImpact,
    previous_fingerprint: &mut Option<u64>,
    fingerprint: impl FnOnce() -> Option<u64>,
) -> Option<ChangeKind> {
    // Ignored-tree churn is dropped before any throttle or fingerprint work —
    // it must not re-arm the window, cost a hash, or reach the frontend.
    if impact == PathImpact::Ignored {
        return None;
    }
    // A graph event may upgrade an earlier worktree event in the same burst;
    // everything else inside the window is left to the frontend debounce. Both
    // suppressed cases are decided without a fingerprint.
    if throttled && (last_kind == ChangeKind::Graph || impact == PathImpact::Worktree) {
        return None;
    }
    let current = matches!(impact, PathImpact::Graph | PathImpact::Ambiguous)
        .then(fingerprint)
        .flatten();
    let kind = resolve_change_kind(impact, previous_fingerprint, current);
    // An ambiguous root event whose refs were unchanged is worktree noise.
    if throttled && kind == ChangeKind::Worktree {
        return None;
    }
    Some(kind)
}

fn graph_fingerprint(root: &Path) -> Option<u64> {
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

#[cfg(test)]
mod tests {
    use super::{
        classify_paths, decide_emission, detach, index_has_path_or_descendant, install_watch,
        is_ignored, resolve_change_kind, resolve_watch_roots, ChangeKind, CommondirSubscriber,
        EmitState, PathImpact, SharedWatch, TabWatch, WatchRoots, WatcherState, Watchers,
    };
    use notify::RecommendedWatcher;
    use std::cell::Cell;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    fn paths(values: &[&str]) -> Vec<PathBuf> {
        values.iter().map(PathBuf::from).collect()
    }

    /// The roots of a linked worktree at `/wt` whose main checkout is `/main`.
    fn linked_worktree_roots() -> WatchRoots {
        WatchRoots {
            workdir: PathBuf::from("/wt"),
            gitdir: Some(PathBuf::from("/main/.git/worktrees/wt")),
            commondir: Some(PathBuf::from("/main/.git")),
        }
    }

    /// Ignore predicate for tests that exercise classification without a real
    /// repository: nothing is ignored.
    fn none_ignored(_: &Path) -> bool {
        false
    }

    /// Stand-in for the repo's ignore rules in a typical GitLane-like project.
    fn build_dirs_ignored(relative: &Path) -> bool {
        relative.starts_with("node_modules") || relative.starts_with("src-tauri/target")
    }

    #[test]
    fn worktree_and_index_changes_do_not_request_graph_rebuilds() {
        let roots = WatchRoots::plain("/repo");
        assert_eq!(
            classify_paths(
                &roots,
                &paths(&["/repo/src/main.ts", "/repo/.git/index"]),
                none_ignored
            ),
            PathImpact::Worktree
        );
    }

    #[test]
    fn refs_head_and_unknown_git_metadata_request_full_refresh() {
        let roots = WatchRoots::plain("/repo");
        for path in [
            "/repo/.git/HEAD",
            "/repo/.git/refs/heads/main",
            "/repo/.git/packed-refs",
            "/repo/.git/objects/ab/cdef",
        ] {
            assert_eq!(
                classify_paths(&roots, &paths(&[path]), none_ignored),
                PathImpact::Graph,
                "{path}"
            );
        }
    }

    /// The Windows regression (GL-101): `ReadDirectoryChangesW` reports every
    /// file a `cargo build` / `bun install` touches, so churn confined to
    /// ignored trees must classify as `Ignored` — not `Worktree` — or each
    /// event re-arms the throttle and drives a redundant status re-sync.
    #[test]
    fn churn_inside_ignored_trees_is_dropped() {
        let roots = WatchRoots::plain("/repo");
        assert_eq!(
            classify_paths(
                &roots,
                &paths(&[
                    "/repo/src-tauri/target/debug/incremental/foo.o",
                    "/repo/node_modules/react/index.js",
                ]),
                build_dirs_ignored
            ),
            PathImpact::Ignored
        );
    }

    #[test]
    fn ignored_churn_does_not_mask_real_changes_in_the_same_event() {
        let roots = WatchRoots::plain("/repo");
        // A tracked worktree file alongside build churn still refreshes status…
        assert_eq!(
            classify_paths(
                &roots,
                &paths(&["/repo/node_modules/react/index.js", "/repo/src/main.ts"]),
                build_dirs_ignored
            ),
            PathImpact::Worktree
        );
        // …and git metadata alongside build churn still rebuilds the graph.
        assert_eq!(
            classify_paths(
                &roots,
                &paths(&["/repo/src-tauri/target/debug/app", "/repo/.git/HEAD"]),
                build_dirs_ignored
            ),
            PathImpact::Graph
        );
    }

    #[test]
    fn ignored_events_are_suppressed_without_fingerprinting_or_rearming() {
        let calls = Cell::new(0);
        let mut fp = Some(1);
        for throttled in [false, true] {
            assert_eq!(
                decide_emission(
                    throttled,
                    ChangeKind::Worktree,
                    PathImpact::Ignored,
                    &mut fp,
                    counting(Some(2), &calls),
                ),
                None
            );
        }
        assert_eq!(calls.get(), 0, "ignored churn must never pay the ref hash");
        assert_eq!(fp, Some(1), "ignored churn must not move the baseline");
    }

    /// `is_ignored` honours the repository's real `.gitignore` (rather than a
    /// hardcoded denylist), and fails open when there is no repo to consult.
    #[test]
    fn ignore_checks_use_the_repositorys_gitignore() {
        let dir = std::env::temp_dir().join(format!("gitlane-watch-ignore-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let repo = git2::Repository::init(&dir).expect("init repo");
        std::fs::write(dir.join(".gitignore"), "target/\nnode_modules/\n").expect("write ignore");

        assert!(is_ignored(Some(&repo), Path::new("target/debug/app.o")));
        assert!(is_ignored(
            Some(&repo),
            Path::new("node_modules/react/index.js")
        ));
        assert!(!is_ignored(Some(&repo), Path::new("src/main.rs")));
        assert!(!is_ignored(Some(&repo), Path::new(".gitignore")));
        // Without a repository the filter fails open: nothing is dropped.
        assert!(!is_ignored(None, Path::new("target/debug/app.o")));

        drop(repo);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `is_path_ignored` is `git check-ignore --no-index` semantics: it flags
    /// tracked files too. A force-added (`git add -f`) file under an ignored
    /// pattern is still status-affecting, so it — and any directory event
    /// naming one of its parents — must fail open rather than be dropped.
    #[test]
    fn force_added_files_under_ignored_patterns_are_not_dropped() {
        let dir = std::env::temp_dir().join(format!("gitlane-watch-forced-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("target/debug")).expect("create dirs");
        let repo = git2::Repository::init(&dir).expect("init repo");
        std::fs::write(dir.join(".gitignore"), "target/\n").expect("write ignore");
        std::fs::write(dir.join("target/debug/keep.txt"), "pinned").expect("write keep");

        // Before the force-add, the whole tree is droppable churn.
        assert!(is_ignored(Some(&repo), Path::new("target/debug/keep.txt")));

        let mut index = repo.index().expect("index");
        index
            .add_path(Path::new("target/debug/keep.txt"))
            .expect("force-add ignored file");
        index.write().expect("write index");

        // The tracked file itself, and directory-level events (FSEvents) for
        // its parents, all stay relevant…
        assert!(!is_ignored(Some(&repo), Path::new("target/debug/keep.txt")));
        assert!(!is_ignored(Some(&repo), Path::new("target/debug")));
        assert!(!is_ignored(Some(&repo), Path::new("target")));
        // …while untracked churn elsewhere under target/ is still dropped.
        assert!(is_ignored(Some(&repo), Path::new("target/debug/app.o")));
        assert!(is_ignored(Some(&repo), Path::new("target/release")));

        drop(repo);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The index sorts by raw path bytes, so `dir.txt` sits between `dir` and
    /// `dir/…`. The descendant probe must not mistake such a neighbour for a
    /// tracked child, and must still find a real one.
    #[test]
    fn descendant_probe_is_not_fooled_by_byte_order_neighbours() {
        let dir = std::env::temp_dir().join(format!("gitlane-watch-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("dir")).expect("create dirs");
        let repo = git2::Repository::init(&dir).expect("init repo");
        std::fs::write(dir.join("dir.txt"), "neighbour").expect("write neighbour");
        std::fs::write(dir.join("dir/keep"), "child").expect("write child");

        let mut index = repo.index().expect("index");
        index.add_path(Path::new("dir.txt")).expect("add neighbour");
        assert!(index_has_path_or_descendant(&index, "dir.txt"));
        assert!(
            !index_has_path_or_descendant(&index, "dir"),
            "a byte-order neighbour is not a descendant"
        );
        assert!(!index_has_path_or_descendant(&index, "di"));

        index.add_path(Path::new("dir/keep")).expect("add child");
        assert!(index_has_path_or_descendant(&index, "dir"));
        assert!(index_has_path_or_descendant(&index, "dir/keep"));
        assert!(!index_has_path_or_descendant(&index, "dir/k"));

        drop(index);
        drop(repo);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The P0-5 scenario: a linked worktree's own git state lives under
    /// `<main>/.git/worktrees/<name>/`. Index churn there is a status refresh;
    /// HEAD / MERGE_HEAD / rebase state (a terminal checkout, a conflict
    /// started outside GitLane) must rebuild the graph.
    #[test]
    fn linked_worktree_private_gitdir_events_classify_like_dot_git() {
        let roots = linked_worktree_roots();
        assert_eq!(
            classify_paths(
                &roots,
                &paths(&["/main/.git/worktrees/wt/index"]),
                none_ignored
            ),
            PathImpact::Worktree
        );
        for path in [
            "/main/.git/worktrees/wt/HEAD",
            "/main/.git/worktrees/wt/MERGE_HEAD",
            "/main/.git/worktrees/wt/rebase-merge/msgnum",
        ] {
            assert_eq!(
                classify_paths(&roots, &paths(&[path]), none_ignored),
                PathImpact::Graph,
                "{path}"
            );
        }
    }

    /// Shared metadata in the common dir (refs, packed-refs, objects) rebuilds
    /// the graph; the main checkout's HEAD moves the worktree list too.
    #[test]
    fn linked_worktree_commondir_refs_request_graph_rebuilds() {
        let roots = linked_worktree_roots();
        for path in [
            "/main/.git/refs/heads/feature",
            "/main/.git/packed-refs",
            "/main/.git/HEAD",
            "/main/.git/objects/ab/cdef",
        ] {
            assert_eq!(
                classify_paths(&roots, &paths(&[path]), none_ignored),
                PathImpact::Graph,
                "{path}"
            );
        }
    }

    /// Foreign working state — the main checkout's index, or a *sibling*
    /// worktree's private files — never affects this window and must be
    /// dropped, not re-arm the throttle. A sibling's HEAD is the exception:
    /// the worktree list shows each checkout's branch.
    #[test]
    fn foreign_checkout_state_in_the_commondir_is_dropped() {
        let roots = linked_worktree_roots();
        for path in [
            "/main/.git/index",
            "/main/.git/index.lock",
            "/main/.git/COMMIT_EDITMSG",
            "/main/.git/worktrees/other/index",
            "/main/.git/worktrees/other/COMMIT_EDITMSG",
            "/main/.git/worktrees/other/rebase-merge/msgnum",
        ] {
            assert_eq!(
                classify_paths(&roots, &paths(&[path]), none_ignored),
                PathImpact::Ignored,
                "{path}"
            );
        }
        assert_eq!(
            classify_paths(
                &roots,
                &paths(&["/main/.git/worktrees/other/HEAD"]),
                none_ignored
            ),
            PathImpact::Graph
        );
        // Dropped foreign churn must not mask a real change in the same event.
        assert_eq!(
            classify_paths(
                &roots,
                &paths(&["/main/.git/index", "/wt/src/main.ts"]),
                none_ignored
            ),
            PathImpact::Worktree
        );
    }

    /// Directory-level events on the common dir (or a worktree's dir) defer to
    /// the ref fingerprint rather than dropping or always rebuilding.
    #[test]
    fn commondir_directory_events_are_ambiguous() {
        let roots = linked_worktree_roots();
        for path in ["/main/.git", "/main/.git/worktrees/other"] {
            assert_eq!(
                classify_paths(&roots, &paths(&[path]), none_ignored),
                PathImpact::Ambiguous,
                "{path}"
            );
        }
    }

    /// The GL-125 fan-out: one shared common-dir event is classified from each
    /// subscribed tab's own perspective, so a single shared watch can serve every
    /// worktree tab of a repository. A worktree's HEAD move (in its private
    /// gitdir under the common dir) is graph-worthy for that tab *and* for every
    /// sibling — their worktree list shows its branch — so both must surface it.
    #[test]
    fn shared_commondir_event_classifies_per_subscriber() {
        // The owning tab (/wt): matches its private gitdir before the common dir.
        let owner = linked_worktree_roots();
        // A sibling worktree (/other) of the same repository, sharing the dir.
        let sibling = WatchRoots {
            workdir: PathBuf::from("/other"),
            gitdir: Some(PathBuf::from("/main/.git/worktrees/other")),
            commondir: Some(PathBuf::from("/main/.git")),
        };
        let event = paths(&["/main/.git/worktrees/wt/HEAD"]);
        assert_eq!(
            classify_paths(&owner, &event, none_ignored),
            PathImpact::Graph,
            "the owning tab sees its own HEAD move"
        );
        assert_eq!(
            classify_paths(&sibling, &event, none_ignored),
            PathImpact::Graph,
            "a sibling tab sees it through the common dir"
        );
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

    #[test]
    fn root_events_use_the_ref_fingerprint() {
        assert_eq!(
            classify_paths(
                &WatchRoots::plain("/repo"),
                &paths(&["/repo"]),
                none_ignored
            ),
            PathImpact::Ambiguous
        );
        let mut fingerprint = Some(10);
        assert_eq!(
            resolve_change_kind(PathImpact::Ambiguous, &mut fingerprint, Some(10)),
            ChangeKind::Worktree
        );
        assert_eq!(
            resolve_change_kind(PathImpact::Ambiguous, &mut fingerprint, Some(11)),
            ChangeKind::Graph
        );
        assert_eq!(fingerprint, Some(11));
    }

    #[test]
    fn ambiguous_events_are_conservative_when_fingerprinting_fails() {
        let mut fingerprint = Some(10);
        assert_eq!(
            resolve_change_kind(PathImpact::Ambiguous, &mut fingerprint, None),
            ChangeKind::Graph
        );
    }

    /// A fingerprint source that records how many times it was invoked, so the
    /// laziness guarantee (no O(refs) hash on suppressed bursts) is testable.
    fn counting(value: Option<u64>, calls: &Cell<u32>) -> impl FnOnce() -> Option<u64> + '_ {
        move || {
            calls.set(calls.get() + 1);
            value
        }
    }

    #[test]
    fn repeated_graph_events_in_a_burst_hash_refs_once() {
        // Within the throttle window, a follow-up graph event is suppressed
        // without recomputing the fingerprint — the prior graph emit covers it.
        let calls = Cell::new(0);
        let mut fp = Some(1);
        let decision = decide_emission(
            true,
            ChangeKind::Graph,
            PathImpact::Graph,
            &mut fp,
            counting(Some(2), &calls),
        );
        assert_eq!(decision, None);
        assert_eq!(
            calls.get(),
            0,
            "suppressed graph repeat must not fingerprint"
        );
    }

    #[test]
    fn worktree_events_emit_without_fingerprinting() {
        let calls = Cell::new(0);
        let mut fp = None;
        assert_eq!(
            decide_emission(
                false,
                ChangeKind::Worktree,
                PathImpact::Worktree,
                &mut fp,
                counting(Some(9), &calls),
            ),
            Some(ChangeKind::Worktree)
        );
        // Throttled worktree noise is suppressed, also without a hash.
        assert_eq!(
            decide_emission(
                true,
                ChangeKind::Worktree,
                PathImpact::Worktree,
                &mut fp,
                counting(Some(9), &calls),
            ),
            None
        );
        assert_eq!(calls.get(), 0, "worktree events never need the ref hash");
    }

    #[test]
    fn graph_event_upgrades_a_worktree_burst_and_refreshes_the_baseline() {
        let calls = Cell::new(0);
        let mut fp = Some(1);
        assert_eq!(
            decide_emission(
                true,
                ChangeKind::Worktree,
                PathImpact::Graph,
                &mut fp,
                counting(Some(2), &calls),
            ),
            Some(ChangeKind::Graph)
        );
        assert_eq!(fp, Some(2), "graph event updates the fingerprint baseline");
        assert_eq!(
            calls.get(),
            1,
            "the upgrade hashes the ref set exactly once"
        );
    }

    #[test]
    fn ambiguous_events_compare_the_ref_fingerprint() {
        let calls = Cell::new(0);
        let mut fp = Some(5);
        // Unchanged refs -> worktree (status-only), emitted when not throttled.
        assert_eq!(
            decide_emission(
                false,
                ChangeKind::Worktree,
                PathImpact::Ambiguous,
                &mut fp,
                counting(Some(5), &calls),
            ),
            Some(ChangeKind::Worktree)
        );
        // Changed refs -> graph, and the baseline advances.
        assert_eq!(
            decide_emission(
                false,
                ChangeKind::Worktree,
                PathImpact::Ambiguous,
                &mut fp,
                counting(Some(6), &calls),
            ),
            Some(ChangeKind::Graph)
        );
        assert_eq!(fp, Some(6));
    }
}
