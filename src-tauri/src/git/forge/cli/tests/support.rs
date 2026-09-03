//! Shared imports for the cli tests.

pub(super) use super::super::super::bounded_output::{self, CaptureError};
pub(super) use super::super::super::domain::{GithubError, GithubRepository, GH_PROVIDER};
pub(super) use super::super::capabilities::{parse_gh_version, GhCapabilities, MIN_GH_VERSION};
pub(super) use super::super::command::{finish_gh_bytes, gh_command, map_gh_capture_error};
pub(super) use super::super::*;
