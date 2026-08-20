//! The capture's public failure shape, and the reader-thread failure it is
//! built from.

use std::fmt;
use std::io;

#[derive(Debug)]
pub(in crate::git::forge) enum CaptureError {
    Spawn(io::Error),
    ReaderStart {
        stream: &'static str,
        source: io::Error,
    },
    Read {
        stream: &'static str,
        source: io::Error,
    },
    WriteStdin(io::Error),
    Allocate {
        stream: &'static str,
    },
    TooLarge {
        stream: &'static str,
        limit: usize,
    },
    ReaderPanicked {
        stream: &'static str,
    },
    Wait(io::Error),
}

impl fmt::Display for CaptureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn(source) => write!(f, "failed to spawn provider CLI: {source}"),
            Self::ReaderStart { stream, source } => {
                write!(f, "failed to start the {stream} reader: {source}")
            }
            Self::Read { stream, source } => write!(f, "failed to read {stream}: {source}"),
            Self::WriteStdin(source) => write!(f, "failed to write provider CLI stdin: {source}"),
            Self::Allocate { stream } => {
                write!(f, "failed to allocate the bounded {stream} buffer")
            }
            Self::TooLarge { stream, limit } => write!(
                f,
                "{stream} exceeded the {limit}-byte output limit; partial output was discarded"
            ),
            Self::ReaderPanicked { stream } => write!(f, "the {stream} reader panicked"),
            Self::Wait(source) => write!(f, "failed to wait for the provider CLI: {source}"),
        }
    }
}

#[derive(Debug)]
pub(super) enum ReaderError {
    Read(io::Error),
    Allocate,
    TooLarge,
    Panicked,
}
