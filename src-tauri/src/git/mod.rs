//! Git access layer for GitLane.
//!
//! - [`read`]   — libgit2-backed repo, branch, graph, and identity reads.
//! - [`status`] — libgit2-backed working-tree, commit, and range diffs.
//! - [`conflicts`] — libgit2 conflict + in-progress-operation detection.
//! - [`graph`]  — facade for DAG → lane layout and graph ref/stash helpers.
//! - [`write`]  — facade for mutating operations shelled out to real `git`.
//! - [`forge`]  — remote URL forge detection for provider routing/errors.
//! - [`github`] — GitHub accounts + pull requests, shelled out to the `gh` CLI.
//! - [`types`]  — serializable types shared with the frontend.

pub mod conflicts;
pub mod forge;
pub mod github;
pub mod graph;
pub mod read;
pub mod status;
pub mod types;
pub mod write;
