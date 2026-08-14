//! Lane reservations: what each column is waiting to render, and slot allocation.

use git2::Oid;

/// A lane reservation: the parent oid this lane is waiting to render, and what
/// kind of reservation it is (see [`LaneKind`]).
pub(super) struct Lane {
    pub(super) waiting: Oid,
    pub(super) kind: LaneKind,
}

/// How a lane came to await its commit. When a commit is awaited by both a
/// branch-root lane and a continuation, the branch-root lane wins — that's what
/// gives a merged branch its own column rather than collapsing onto the first
/// parent's lane. A `Blocked` lane renders nothing and claims nothing, but holds
/// its column out of [`alloc_lane`]'s reach until `waiting` renders, so the
/// connector still travelling down it is never overdrawn by an unrelated branch.
#[derive(Clone, Copy, PartialEq)]
pub(super) enum LaneKind {
    /// Plain first-parent continuation of the commit above.
    Cont,
    /// Opened because a merge pulled the parent in as a topic branch.
    Root,
    /// Held open for HEAD's in-flight hand-off connector.
    Blocked,
}

impl Lane {
    pub(super) fn cont(waiting: Oid) -> Self {
        Lane {
            waiting,
            kind: LaneKind::Cont,
        }
    }
    pub(super) fn root(waiting: Oid) -> Self {
        Lane {
            waiting,
            kind: LaneKind::Root,
        }
    }
    pub(super) fn blocked(waiting: Oid) -> Self {
        Lane {
            waiting,
            kind: LaneKind::Blocked,
        }
    }
}

/// Find a free lane slot, reusing the lowest gap if one exists, otherwise
/// appending a new lane.
pub(super) fn alloc_lane(lanes: &mut Vec<Option<Lane>>) -> usize {
    match lanes.iter().position(|s| s.is_none()) {
        Some(i) => i,
        None => {
            lanes.push(None);
            lanes.len() - 1
        }
    }
}
