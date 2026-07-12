//! Working-tree status and diff reads via libgit2 (`git2`).
//!
//! Like [`super::read`], every function takes a filesystem path and opens the
//! repo fresh — `git2::Repository` is not `Send`, so we never hold one across
//! the async Tauri command boundary. Open, read, drop. This facade keeps the
//! `git::status::*` IPC-facing surface stable while focused siblings own shared
//! diff conversion, working-tree reads, commit reads, and range reads.

mod advanced;
mod blob;
mod commit;
mod compare;
mod diff;
mod files;
mod history;
mod range;
mod selection;
#[cfg(test)]
mod tests;
mod working;

pub use blob::read_binary_blob;
pub use commit::{commit_file_diff, commit_files};
pub use compare::{compare_file_diff, compare_refs};
pub use files::{list_repo_files, repo_file_head_text, repo_file_text};
pub use history::{file_blame, file_history};
pub use range::{diff_range, diff_range_file};
pub use selection::{selection_diff, selection_diff_file};
pub use working::{file_diff, working_changes};
