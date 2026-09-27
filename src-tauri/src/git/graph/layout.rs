//! Commit graph construction and swimlane layout.

mod build;
mod lanes;

pub use build::build;
pub(crate) use build::seed_walk;
#[cfg(test)]
#[allow(unused_imports)]
pub use build::{build_profiled, GraphBuildMetrics};
