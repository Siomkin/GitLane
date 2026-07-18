//! Git access layer for GitLane.
//!
//! - [`read`]   — libgit2-backed repo, branch, graph, and identity reads.
//! - [`status`] — libgit2-backed working-tree, commit, and range diffs.
//! - [`conflicts`] — libgit2 conflict + in-progress-operation detection.
//! - [`graph`]  — facade for DAG → lane layout and graph ref/stash helpers.
//! - [`write`]  — facade for mutating operations shelled out to real `git`.
//! - [`forge`]  — remote URL forge detection for provider routing/errors.
//! - [`github`] — GitHub accounts + pull requests, shelled out to the `gh` CLI.
//! - [`handoff`] — shared marker for the worktree branch-handoff carry flow.
//! - [`oauth`]  — native provider OAuth sign-in (GitLab device / Bitbucket PKCE).
//! - [`types`]  — serializable types shared with the frontend.

pub mod conflicts;
pub mod credential_bridge;
pub mod credentials;
pub mod forge;
pub mod github;
pub mod graph;
pub mod handoff;
pub mod oauth;
pub mod provider_tokens;
pub mod read;
pub mod status;
pub mod transport_auth;
pub mod types;
mod worktree_fs;
pub mod write;
