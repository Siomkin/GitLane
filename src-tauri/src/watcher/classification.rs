//! Filesystem-event classification and emission policy for repository watches.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::WatchRoots;

/// Mutable per-tab emission bookkeeping. A worktree tab's events arrive from
/// two watchers — its own workdir watcher and the shared common-dir watcher
/// that fans out to it (GL-125) — so this state is shared (`Arc<Mutex<_>>`) and
/// the throttle window / ref fingerprint coalesce events from both sources.
pub(super) struct EmitState {
    pub(super) last: Instant,
    pub(super) last_kind: ChangeKind,
    pub(super) last_graph_fingerprint: Option<u64>,
}

/// Minimum gap between emitted events, to collapse the burst of fs events a
/// single git operation produces.
pub(super) const THROTTLE: Duration = Duration::from_millis(300);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum ChangeKind {
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

/// Classify one filesystem event for a single tab and emit `repo-changed` when
/// it warrants a re-sync. Shared by a tab's private (workdir) watcher and the
/// shared common-dir watcher's fan-out, so the tab's throttle/fingerprint state
/// (`state`) coalesces events from both sources into one window.
pub(super) fn handle_event(
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
    let rank = |impact| match impact {
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
        return if is_ignored(relative) {
            PathImpact::Ignored
        } else {
            PathImpact::Worktree
        };
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
        return PathImpact::Ambiguous;
    };
    match first.as_os_str().to_string_lossy().as_ref() {
        // Another worktree's private dir. Only its HEAD is visible in this
        // window (the worktree list shows each checkout's branch); its index /
        // merge / rebase state belongs to that checkout alone.
        "worktrees" => {
            let mut rest = components.skip(1);
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
/// against slash-separated paths (Windows events arrive with `\\`). Errors and
/// the no-repo case also fall back to "not ignored", so filtering can only
/// ever suppress noise, never a real change.
pub(super) fn is_ignored(repo: Option<&git2::Repository>, relative: &Path) -> bool {
    // `is_path_ignored` also matches tracked files, so index presence must fail
    // open: a force-added ignored path still affects status.
    let Some(repo) = repo else { return false };
    let mut normalized = String::new();
    for component in relative.components() {
        if !normalized.is_empty() {
            normalized.push('/');
        }
        normalized.push_str(&component.as_os_str().to_string_lossy());
    }
    if normalized.is_empty() || !repo.is_path_ignored(&normalized).unwrap_or(false) {
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
    // both suppressed cases are decided without a fingerprint.
    if throttled && (last_kind == ChangeKind::Graph || impact == PathImpact::Worktree) {
        return None;
    }
    let current = matches!(impact, PathImpact::Graph | PathImpact::Ambiguous)
        .then(fingerprint)
        .flatten();
    let kind = resolve_change_kind(impact, previous_fingerprint, current);
    if throttled && kind == ChangeKind::Worktree {
        return None;
    }
    Some(kind)
}

pub(super) fn graph_fingerprint(root: &Path) -> Option<u64> {
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
    use super::*;
    use crate::watcher::WatchRoots;
    use std::cell::Cell;
    use std::path::{Path, PathBuf};

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
    fn empty_path_list_is_a_conservative_worktree_refresh() {
        assert_eq!(
            classify_paths(&WatchRoots::plain("/repo"), &[], none_ignored),
            PathImpact::Worktree
        );
    }

    #[test]
    fn ambiguous_root_outweighs_a_worktree_path() {
        assert_eq!(
            classify_paths(
                &WatchRoots::plain("/repo"),
                &paths(&["/repo", "/repo/src/main.ts"]),
                none_ignored
            ),
            PathImpact::Ambiguous
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
