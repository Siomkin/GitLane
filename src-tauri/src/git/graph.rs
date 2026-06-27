//! Commit-graph construction and lane (column) layout.
//!
//! This is the heart of the visual client: we walk the commit DAG and assign
//! every commit a `lane` so the frontend can paint the swimlane columns.
//! The facade keeps `git::graph::*` stable while focused siblings own stash
//! injection, ref labeling, and the lane-layout pipeline.

mod layout;
mod refs;
mod stashes;
#[cfg(test)]
mod tests;

pub use layout::build;
#[cfg(test)]
#[allow(unused_imports)]
pub use layout::{build_profiled, GraphBuildMetrics};
