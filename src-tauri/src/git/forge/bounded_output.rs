//! Concurrent, hard-bounded output capture for provider CLI children.
//!
//! Reading one pipe to completion before the other can deadlock when a child
//! fills the unattended pipe. Provider CLIs also return remote-controlled JSON
//! and patch text, so `Command::output`'s unbounded buffers are not appropriate
//! at this boundary. This module drains both streams concurrently and never
//! retains more than the configured limits.
//!
//! The two streams overflow differently because they mean different things.
//! stdout is the payload a parser consumes, so a truncated body must never be
//! returned: overflow kills and reaps the child and discards the partial
//! output. stderr is diagnostics — dropped entirely on success, quoted only in
//! a failure message — so overflow keeps the bounded prefix and lets the child
//! finish normally. A chatty-but-successful CLI (`GH_DEBUG=api` alone can
//! exceed the stderr limit) must not fail an operation whose stdout arrived
//! complete. [`limits::STDERR_DRAIN_CEILING`] still bounds how much excess is drained
//! before the stream counts as a runaway and fails like stdout does.
//!
//! It deliberately does not manage a process tree: a descendant that inherits a
//! pipe handle can delay reader EOF after the direct child exits. Provider CLIs
//! are expected not to leave such descendants behind.
//!
//! Facade over the focused submodules: `limits` (the byte ceilings), `error`
//! (the failure shapes), `reader` (the per-stream reader threads), and
//! `capture` (spawning, joining, and reaping the child).

mod capture;
mod error;
mod limits;
mod reader;
#[cfg(test)]
mod tests;

pub(in crate::git::forge) use capture::{capture, capture_with_stdin, BoundedOutput};
pub(in crate::git::forge) use error::CaptureError;
pub(in crate::git::forge) use limits::{
    stderr_truncated_notice, DEFAULT_STDOUT_LIMIT, DIFF_STDOUT_LIMIT, STDERR_LIMIT,
};
