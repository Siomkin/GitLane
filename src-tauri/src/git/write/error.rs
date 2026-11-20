//! A write failure whose kind is decided where GitLane detects it.
//!
//! Most of the write layer still reports `String` diagnostics, which get their
//! [`CommandError`] kind from [`classify_failure`] at the IPC edge. That is the
//! only option for git's own stderr. A failure GitLane itself authors (a lease
//! that went stale, a target that is already a repository) is typed here
//! instead, so rewording its message cannot change the kind the frontend sees.
//!
//! During migration the type converts to and from `String` both ways: a typed
//! function can `?` an untyped helper (its text becomes [`WriteError::Git`]),
//! and an untyped caller can `?` a typed function (the text is unchanged, so
//! the classifier still recovers the same kind).

use super::classify::{classify_failure, STALE_SUFFIX};
use crate::git::types::{CommandError, CommandErrorKind, RepoOpenError};

/// A write-layer failure.
#[derive(Debug, Clone, thiserror::Error)]
pub enum WriteError {
    /// An exact-state lease failed: what the user confirmed no longer matches.
    /// The message ends with [`STALE_SUFFIX`]; build it with
    /// [`WriteError::stale`].
    #[error("{0}")]
    StaleLease(String),
    /// The target path is already an openable git repository.
    #[error("{0}")]
    AlreadyARepository(String),
    /// Opening the repository failed; keeps libgit2's missing-path /
    /// not-a-repository kind instead of flattening it to text.
    #[error("{}", .0.message)]
    Open(RepoOpenError),
    /// git's own (redacted) diagnostic, or a GitLane message not typed yet.
    /// Classified from its text at the IPC edge.
    #[error("{0}")]
    Git(String),
}

impl WriteError {
    /// A stale-lease failure: `reason` followed by [`STALE_SUFFIX`].
    pub(crate) fn stale(reason: &str) -> Self {
        Self::StaleLease(format!("{reason} {STALE_SUFFIX}"))
    }
}

impl From<String> for WriteError {
    fn from(message: String) -> Self {
        Self::Git(message)
    }
}

impl From<WriteError> for String {
    fn from(error: WriteError) -> Self {
        error.to_string()
    }
}

impl From<WriteError> for CommandError {
    fn from(error: WriteError) -> Self {
        match error {
            WriteError::StaleLease(message) => {
                CommandError::new(CommandErrorKind::StaleLease, message)
            }
            WriteError::AlreadyARepository(message) => {
                CommandError::new(CommandErrorKind::Git, message).with_code("alreadyARepository")
            }
            WriteError::Open(error) => CommandError::from(error),
            WriteError::Git(message) => classify_failure(&message),
        }
    }
}

#[cfg(test)]
mod tests;
