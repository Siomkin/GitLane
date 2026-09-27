//! Commit graph construction and swimlane layout.

mod build;
mod lanes;

pub use build::build;
#[cfg(test)]
pub use build::build_profiled;
pub(crate) use build::seed_walk;
