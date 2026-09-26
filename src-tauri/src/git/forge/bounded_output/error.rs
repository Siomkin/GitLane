//! The capture's public failure shape, and the reader-thread failure it is
//! built from.

use std::io;

use crate::git::types::{CommandError, CommandErrorKind};

#[derive(Debug, thiserror::Error)]
pub(crate) enum CaptureError {
    #[error("failed to spawn provider CLI: {0}")]
    Spawn(io::Error),
    #[error("failed to start the {stream} reader: {source}")]
    ReaderStart {
        stream: &'static str,
        source: io::Error,
    },
    #[error("failed to read {stream}: {source}")]
    Read {
        stream: &'static str,
        source: io::Error,
    },
    #[error("failed to allocate the bounded {stream} buffer")]
    Allocate { stream: &'static str },
    #[error("{stream} exceeded the {limit}-byte output limit; partial output was discarded")]
    TooLarge { stream: &'static str, limit: usize },
    #[error("the {stream} reader panicked")]
    ReaderPanicked { stream: &'static str },
    #[error("failed to wait for the provider CLI: {0}")]
    Wait(io::Error),
    #[error("the provider CLI did not finish in time and was stopped")]
    TimedOut,
}

/// A capture failure is a provider-tooling failure, never auth or network;
/// the oversized-output case gets its own code so the UI can say "too big".
impl From<CaptureError> for CommandError {
    fn from(error: CaptureError) -> Self {
        let code = match error {
            CaptureError::TooLarge { .. } => "outputTooLarge",
            _ => "captureFailed",
        };
        CommandError::new(CommandErrorKind::Forge, error.to_string()).with_code(code)
    }
}

/// Why a provider-CLI run (`gh`, `glab`, `origin`) produced no output. A
/// capture failure stays typed so `forge::ipc` can apply the `CaptureError`
/// mapping above (`outputTooLarge` / `captureFailed`); everything else is the
/// CLI's own redacted message, classified later with its operation context.
#[derive(Debug)]
pub(in crate::git::forge) enum CliError {
    Capture {
        tool: &'static str,
        error: CaptureError,
    },
    Failed(String),
}

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Capture { tool, error } => write!(f, "{tool} {error}"),
            Self::Failed(message) => f.write_str(message),
        }
    }
}

impl From<String> for CliError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

/// The `Result<_, String>` call sites keep today's text.
impl From<CliError> for String {
    fn from(error: CliError) -> Self {
        error.to_string()
    }
}

#[derive(Debug, thiserror::Error)]
pub(super) enum ReaderError {
    #[error("read failed: {0}")]
    Read(io::Error),
    #[error("could not allocate the bounded buffer")]
    Allocate,
    #[error("output exceeded the bounded limit")]
    TooLarge,
    #[error("reader panicked")]
    Panicked,
}
