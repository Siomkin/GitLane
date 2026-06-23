//! Filesystem watching for the open repository.
//!
//! Watches the worktree (recursively — includes `.git`, so commits, checkouts,
//! staging and file edits all register) and emits a classified `repo-changed`
//! Tauri event. Worktree/index-only events refresh status without rebuilding
//! the graph; refs/HEAD/other git metadata conservatively request a full sync.
//!
//! macOS uses FSEvents (directory-level, cheap) so a recursive watch of the
//! worktree is fine even with large `node_modules`/`target` trees. Bursts are
//! throttled here and debounced again on the frontend.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use std::{path::Path, path::PathBuf};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Holds the active watcher. Replacing it drops the previous one, which stops
/// the old watch — so switching repos never leaves a stale watcher running.
#[derive(Default)]
pub struct WatcherState(pub Mutex<Option<RecommendedWatcher>>);

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
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoChangedEvent {
    kind: ChangeKind,
}

pub fn watch(app: &AppHandle, state: &WatcherState, path: &str) -> Result<(), String> {
    let app = app.clone();
    let root = PathBuf::from(path);
    let mut last = Instant::now() - THROTTLE;
    let mut last_kind = ChangeKind::Worktree;
    let mut last_graph_fingerprint = graph_fingerprint(&root);

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        // Ignore pure reads — only mutations should trigger a re-sync.
        if event.kind.is_access() {
            return;
        }
        let impact = classify_paths(&root, &event.paths);
        let now = Instant::now();
        let throttled = now.duration_since(last) < THROTTLE;
        // Pass a *lazy* fingerprint: `decide_emission` only hashes the ref set
        // when the decision actually depends on it, so a burst of `.git/refs`
        // writes (fetch/gc/rebase) hashes once instead of once per fs event.
        let Some(kind) = decide_emission(
            throttled,
            last_kind,
            impact,
            &mut last_graph_fingerprint,
            || graph_fingerprint(&root),
        ) else {
            return;
        };
        last = now;
        last_kind = kind;
        let _ = app.emit("repo-changed", RepoChangedEvent { kind });
    })
    .map_err(|e| format!("failed to create watcher: {e}"))?;

    watcher
        .watch(std::path::Path::new(path), RecursiveMode::Recursive)
        .map_err(|e| format!("failed to watch {path}: {e}"))?;

    // Replaces (and drops) any previous watcher.
    *state.0.lock().map_err(|e| e.to_string())? = Some(watcher);
    Ok(())
}

fn classify_paths(root: &Path, paths: &[PathBuf]) -> PathImpact {
    for path in paths {
        let Ok(relative) = path.strip_prefix(root) else {
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
            continue;
        }

        let Some(metadata) = components.next() else {
            return PathImpact::Graph;
        };
        let name = metadata.as_os_str().to_string_lossy();
        if name != "index" && name != "index.lock" && name != "COMMIT_EDITMSG" {
            return PathImpact::Graph;
        }
    }
    PathImpact::Worktree
}

fn resolve_change_kind(
    impact: PathImpact,
    previous_fingerprint: &mut Option<u64>,
    current_fingerprint: Option<u64>,
) -> ChangeKind {
    match impact {
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
                .or_else(|| reference.symbolic_target().ok().flatten().map(str::to_string))
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
    use super::{classify_paths, decide_emission, resolve_change_kind, ChangeKind, PathImpact};
    use std::cell::Cell;
    use std::path::{Path, PathBuf};

    fn paths(values: &[&str]) -> Vec<PathBuf> {
        values.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn worktree_and_index_changes_do_not_request_graph_rebuilds() {
        let root = Path::new("/repo");
        assert_eq!(
            classify_paths(root, &paths(&["/repo/src/main.ts", "/repo/.git/index"])),
            PathImpact::Worktree
        );
    }

    #[test]
    fn refs_head_and_unknown_git_metadata_request_full_refresh() {
        let root = Path::new("/repo");
        for path in [
            "/repo/.git/HEAD",
            "/repo/.git/refs/heads/main",
            "/repo/.git/packed-refs",
            "/repo/.git/objects/ab/cdef",
        ] {
            assert_eq!(
                classify_paths(root, &paths(&[path])),
                PathImpact::Graph,
                "{path}"
            );
        }
    }

    #[test]
    fn root_events_use_the_ref_fingerprint() {
        assert_eq!(
            classify_paths(Path::new("/repo"), &paths(&["/repo"])),
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
