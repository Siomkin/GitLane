//! Guarded hunk and line staging writes.
//!
//! Facade over the focused submodules: `apply` (the public hunk/line entry
//! points), `range` (atomic multi-line stage/unstage and working-tree revert),
//! `runners` (pinned `git diff` args and `git apply`), and `extract` (single-hunk
//! and partial-hunk patch reconstruction).

mod apply;
mod extract;
mod range;
mod runners;

pub use apply::{apply_hunk, apply_line};
pub use range::{apply_line_range, revert_line_range};
#[cfg(test)]
pub(super) use runners::{apply_hunk_patch, patch_diff_args};
