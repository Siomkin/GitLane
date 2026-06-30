//! Read-only repository access via libgit2 (`git2`).
//!
//! All functions take a filesystem path and open the repo fresh. `git2`
//! `Repository` handles are not `Send`, so we never hold one across the async
//! Tauri command boundary — open, read, drop. This facade keeps the IPC-facing
//! `git::read::*` surface stable while focused siblings own repo summaries,
//! branches, and repo-local identity.

mod branches;
mod identity;
mod recents;
mod remotes;
mod repo;
#[cfg(test)]
mod tests;

pub use branches::{branches, can_fast_forward};
pub use identity::{default_identity, repo_identity};
pub use recents::recents_status;
pub use remotes::list_remotes;
pub use repo::{commit_graph, open, summary, worktree_join};
