//! Conflict + in-progress-operation detection (libgit2 reads).
//!
//! Like the other read modules, every function takes a path and opens the repo
//! fresh — `git2::Repository` is not `Send`, so we never hold one across the
//! async Tauri command boundary. This facade only *reports* the conflicted
//! state; *resolving* it (accept ours/theirs, stage, continue/abort/skip)
//! shells out to the real `git` binary in [`super::write`], per the read/write
//! split.

mod content;
mod files;
mod operation;
#[cfg(test)]
mod tests;

pub use content::conflict_file;
pub use operation::operation_status;
