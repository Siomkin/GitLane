//! Linked worktrees: their private gitdir, the shared commondir, and how one
//! event classifies differently per subscriber.

use super::super::*;
use super::support::*;
use crate::watcher::WatchRoots;
use std::cell::Cell;
use std::path::PathBuf;

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
