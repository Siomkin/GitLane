//! Shared imports for the cli tests.

pub(super) use super::super::super::domain::{GithubError, GithubRepository, GH_PROVIDER};
pub(super) use super::super::capabilities::{parse_gh_version, MIN_GH_VERSION};
pub(super) use super::super::command::{gh_command, gh_command_in_repository, GH_NOT_FOUND};
pub(super) use super::super::*;
