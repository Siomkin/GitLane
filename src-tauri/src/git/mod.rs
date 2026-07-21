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

use std::process::Command;

// `git -C <repo>` does not override inherited repository-local environment:
// GIT_DIR/GIT_WORK_TREE can redirect a command to a completely different
// worktree, while the other variables can substitute its index or object/ref
// namespace. GitLane always supplies its own repository or intentionally runs
// without one, so none of these may cross a Git subprocess boundary. This is
// Git's `rev-parse --local-env-vars` list plus GIT_NAMESPACE.
pub(crate) const REPOSITORY_LOCAL_ENV_VARS: &[&str] = &[
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
];

pub(crate) fn clear_repository_local_env(command: &mut Command) {
    for key in REPOSITORY_LOCAL_ENV_VARS {
        command.env_remove(key);
    }
}

pub(crate) fn isolated_git_command() -> Command {
    let mut command = Command::new("git");
    clear_repository_local_env(&mut command);
    command
}

pub mod conflicts;
pub mod credential_bridge;
pub mod credentials;
mod file_state;
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
