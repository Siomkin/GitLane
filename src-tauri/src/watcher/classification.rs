//! Filesystem-event classification and emission policy for repository watches.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::AppHandle;

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
pub(crate) enum ChangeKind {
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
    crate::events::emit(
        app,
        crate::events::REPO_CHANGED,
        crate::events::RepoChangedEvent {
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
mod tests;
