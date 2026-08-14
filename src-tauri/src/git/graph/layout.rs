//! Commit graph construction and swimlane layout.

mod build;
mod lanes;

pub use build::build;
#[cfg(test)]
#[allow(unused_imports)]
pub use build::{build_profiled, GraphBuildMetrics};
