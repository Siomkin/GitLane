//! The per-stream reader threads: how much they retain, and what they do once
//! a stream passes its limit.

use std::io::{self, Read};
use std::panic::{self, AssertUnwindSafe};
use std::sync::mpsc;
use std::thread::{self, JoinHandle};

use super::error::ReaderError;
use super::limits::{INITIAL_CAPACITY, READ_CHUNK};

/// What a stream does once it has filled its limit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Overflow {
    /// The stream carries the payload: fail so no parser ever sees a truncated
    /// body, and let the parent kill the child.
    Fail,
    /// The stream carries diagnostics: keep the bounded prefix and let the
    /// child finish, escalating to [`Overflow::Fail`] only if the discarded
    /// excess itself passes `ceiling`.
    Truncate { ceiling: usize },
}

#[derive(Debug)]
pub(super) struct ReaderOutput {
    pub(super) bytes: Vec<u8>,
    pub(super) truncated: bool,
}

pub(super) type ReaderResult = Result<ReaderOutput, ReaderError>;

pub(super) fn spawn_reader<R: Read + Send + 'static>(
    stream: &'static str,
    reader: R,
    limit: usize,
    overflow: Overflow,
    tx: mpsc::Sender<(&'static str, ReaderResult)>,
) -> io::Result<JoinHandle<()>> {
    thread::Builder::new()
        .name(format!("gitlane-{stream}-reader"))
        .spawn(move || {
            let mut reported = false;
            let unwind = panic::catch_unwind(AssertUnwindSafe(|| {
                read_and_report(reader, limit, overflow, |result| {
                    reported = true;
                    let _ = tx.send((stream, result));
                });
            }));
            if unwind.is_err() && !reported {
                let _ = tx.send((stream, Err(ReaderError::Panicked)));
            }
        })
}

/// Read at most `limit` bytes, then apply `overflow`.
///
/// Under [`Overflow::Fail`], report as soon as the first excess byte arrives and
/// keep the pipe draining without retaining more data: the parent kills and
/// waits immediately on that report, and continuing to read until EOF prevents a
/// full pipe from blocking process teardown in the meantime.
///
/// Under [`Overflow::Truncate`], drain the excess first and report the bounded
/// prefix only once the stream has actually ended, so a reported `Ok` always
/// means EOF was observed. Excess past the ceiling escalates to the fail path.
pub(super) fn read_and_report(
    mut reader: impl Read,
    limit: usize,
    overflow: Overflow,
    report: impl FnOnce(ReaderResult),
) {
    let complete = |bytes| {
        Ok(ReaderOutput {
            bytes,
            truncated: false,
        })
    };
    let mut output = Vec::new();
    if output
        .try_reserve_exact(limit.min(INITIAL_CAPACITY))
        .is_err()
    {
        report(Err(ReaderError::Allocate));
        drain_to_eof(&mut reader);
        return;
    }
    let mut chunk = [0u8; READ_CHUNK];

    loop {
        let remaining = limit - output.len();
        if remaining == 0 {
            match reader.read(&mut chunk) {
                Ok(0) => report(complete(output)),
                Ok(read) => match overflow {
                    Overflow::Fail => {
                        report(Err(ReaderError::TooLarge));
                        drain_to_eof(&mut reader);
                    }
                    // Those `read` bytes are already discarded, so they count
                    // against the ceiling the rest of the drain gets — and a
                    // single oversized read can exhaust it on its own.
                    Overflow::Truncate { ceiling } => {
                        if read <= ceiling && drain_to_eof_within(&mut reader, ceiling - read) {
                            report(Ok(ReaderOutput {
                                bytes: output,
                                truncated: true,
                            }));
                        } else {
                            report(Err(ReaderError::TooLarge));
                            drain_to_eof(&mut reader);
                        }
                    }
                },
                Err(source) => report(Err(ReaderError::Read(source))),
            }
            return;
        }

        let read_limit = remaining.min(chunk.len());
        let read = match reader.read(&mut chunk[..read_limit]) {
            Ok(read) => read,
            Err(source) => {
                report(Err(ReaderError::Read(source)));
                return;
            }
        };
        if read == 0 {
            report(complete(output));
            return;
        }
        if output.try_reserve_exact(read).is_err() {
            report(Err(ReaderError::Allocate));
            drain_to_eof(&mut reader);
            return;
        }
        output.extend_from_slice(&chunk[..read]);
    }
}

fn drain_to_eof(reader: &mut impl Read) {
    let mut discard = [0u8; READ_CHUNK];
    loop {
        match reader.read(&mut discard) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

/// Discard the rest of `reader`, allowing `budget` further bytes. Returns
/// `true` when the stream ended (or errored) inside that allowance and `false`
/// when it kept producing past it — the caller's cue to treat it as a runaway.
pub(super) fn drain_to_eof_within(reader: &mut impl Read, budget: usize) -> bool {
    let mut discard = [0u8; READ_CHUNK];
    let mut remaining = budget;
    loop {
        match reader.read(&mut discard) {
            Ok(0) | Err(_) => return true,
            Ok(read) if read > remaining => return false,
            Ok(read) => remaining -= read,
        }
    }
}
