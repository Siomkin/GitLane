//! When the ref fingerprint is computed, when it is reused across a burst,
//! and what an unreadable one falls back to.

use super::super::*;
use super::support::*;
use crate::watcher::WatchRoots;
use std::cell::Cell;

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
