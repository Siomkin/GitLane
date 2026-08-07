//! Mutating git operations.
//!
//! These intentionally shell out to the user's real `git` binary rather than
//! using libgit2. The CLI honours hooks, credential helpers, `.gitconfig`,
//! signing, and the full conflict machinery — all of which libgit2 wrappers
//! reimplement only partially.
//!
//! This file declares the layer's modules and nothing else — callers name the
//! owning module (`git::write::branches::create_branch`), not a re-export
//! facade (GL-356; see docs/rules/architecture-rules-rust.md §1). A module is
//! `mod` rather than `pub mod` when nothing outside `git::write` names it:
//! `cli` owns the single git-subprocess site, and the guard/lease helpers are
//! reached through the operations that take them.

pub mod branch_checkout;
pub mod branches;
mod cli;
pub mod commits;
pub mod conflict_resolution;
pub mod discard_all;
pub mod discard_file;
mod empty_dirs;
pub mod files;
mod hard_reset_lease;
mod head;
pub mod history;
pub mod identity;
pub mod ignore;
pub mod index_lock;
pub mod lifecycle;
pub mod open_path;
mod operands;
pub mod patch_staging;
pub mod patches;
mod path_guards;
pub mod recovery;
pub mod remotes;
pub mod reset;
pub mod restore_path;
pub mod reveal;
pub mod staging;
mod stash_push;
pub mod stashes;
mod state_lease;
pub mod tags;
#[cfg(test)]
mod tests;
pub mod worktree_removal_lease;
pub mod worktrees;
