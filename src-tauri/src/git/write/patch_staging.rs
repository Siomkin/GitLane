//! Guarded hunk and line staging writes.
//!
//! Facade over the focused submodules: `apply` (the public hunk/line entry
//! points), `runners` (pinned `git diff` args and `git apply`), and `extract`
//! (single-hunk and single-line patch reconstruction).

mod apply;
mod extract;
mod runners;

pub use apply::{apply_hunk, apply_line};
#[cfg(test)]
pub(super) use runners::{apply_hunk_patch, patch_diff_args};
