//! Git access layer for GitLane.
//!
//! - [`read`]   — libgit2-backed reads (graph, refs, branches).
//! - [`status`] — libgit2-backed working-tree status and diffs.
//! - [`graph`]  — DAG → lane layout for the visual commit tree.
//! - [`write`]  — mutating operations, shelled out to the real `git` binary.
//! - [`forge`]  — remote URL forge detection for provider routing/errors.
//! - [`github`] — GitHub accounts + pull requests, shelled out to the `gh` CLI.
//! - [`types`]  — serializable types shared with the frontend.

pub mod forge;
pub mod github;
pub mod graph;
pub mod read;
pub mod status;
pub mod types;
pub mod write;
