//! Commit, amend, and squash writes.
//!
//! Facade over the focused submodules: `create` (commit and amend),
//! `index_snapshot` (the exact index snapshot and compare-and-restore squash
//! depends on), `hook_restage` (putting a pre-commit hook's contribution back),
//! and `squash` (the guarded squash contract that drives all three).

mod create;
mod hook_restage;
mod index_snapshot;
mod squash;

pub use create::commit_expected;
pub use squash::squash_commits;

#[cfg(test)]
pub use create::commit;
#[cfg(test)]
pub(crate) use squash::{set_squash_after_commit_test_hook, set_squash_after_read_tree_test_hook};
