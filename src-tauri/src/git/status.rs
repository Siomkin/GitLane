//! Working-tree status and diff reads via libgit2 (`git2`).
//!
//! Like [`super::read`], every function takes a filesystem path and opens the
//! repo fresh — `git2::Repository` is not `Send`, so we never hold one across
//! the async Tauri command boundary. Open, read, drop. This facade keeps the
//! `git::status::*` IPC-facing surface stable while focused siblings own shared
//! diff conversion, working-tree reads, commit reads, and range reads.

mod commit;
mod diff;
mod history;
mod range;
#[cfg(test)]
mod tests;
mod working;

pub use commit::{commit_file_diff, commit_files};
pub use history::{file_blame, file_history};
pub use range::{diff_range, diff_range_file};
pub use working::{file_diff, working_changes};
