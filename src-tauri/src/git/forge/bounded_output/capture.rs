//! Spawning the child, joining both readers, and reaping the process.

use std::io;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;

use super::error::{CaptureError, ReaderError};
use super::limits::STDERR_DRAIN_CEILING;
use super::reader::{spawn_reader, Overflow};

#[derive(Debug)]
pub(in crate::git::forge) struct BoundedOutput {
    pub(in crate::git::forge) status: ExitStatus,
    pub(in crate::git::forge) stdout: Vec<u8>,
    pub(in crate::git::forge) stderr: Vec<u8>,
    /// True when diagnostics were cut at [`super::limits::STDERR_LIMIT`]. Only
    /// meaningful on a failure, where stderr becomes part of the message the
    /// user sees.
    pub(in crate::git::forge) stderr_truncated: bool,
}

/// Spawn `command`, drain both pipes concurrently, and return only complete
/// output within both limits. Every successfully spawned child is waited on.
pub(in crate::git::forge) fn capture(
    command: &mut Command,
    stdout_limit: usize,
    stderr_limit: usize,
) -> Result<BoundedOutput, CaptureError> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(CaptureError::Spawn)?;

    let Some(stdout) = child.stdout.take() else {
        abort_and_reap(&mut child);
        return Err(CaptureError::Read {
            stream: "stdout",
            source: io::Error::other("provider CLI stdout was not piped"),
        });
    };
    let Some(stderr) = child.stderr.take() else {
        drop(stdout);
        abort_and_reap(&mut child);
        return Err(CaptureError::Read {
            stream: "stderr",
            source: io::Error::other("provider CLI stderr was not piped"),
        });
    };

    let (tx, rx) = mpsc::channel();
    let stdout_thread =
        match spawn_reader("stdout", stdout, stdout_limit, Overflow::Fail, tx.clone()) {
            Ok(handle) => handle,
            Err(source) => {
                drop(stderr);
                abort_and_reap(&mut child);
                return Err(CaptureError::ReaderStart {
                    stream: "stdout",
                    source,
                });
            }
        };
    let stderr_overflow = Overflow::Truncate {
        ceiling: STDERR_DRAIN_CEILING,
    };
    let stderr_thread =
        match spawn_reader("stderr", stderr, stderr_limit, stderr_overflow, tx.clone()) {
            Ok(handle) => handle,
            Err(source) => {
                abort_and_reap(&mut child);
                let _ = stdout_thread.join();
                return Err(CaptureError::ReaderStart {
                    stream: "stderr",
                    source,
                });
            }
        };
    drop(tx);

    let mut stdout_bytes = None;
    let mut stderr_bytes = None;
    let mut stderr_truncated = false;
    let mut first_error = None;
    let mut received = 0;
    let mut wait_result = None;
    while received < 2 {
        match rx.recv() {
            Ok((stream, Ok(output))) => {
                received += 1;
                match stream {
                    // stdout runs Overflow::Fail, so a successful read is always
                    // complete and its `truncated` flag cannot be set.
                    "stdout" => stdout_bytes = Some(output.bytes),
                    "stderr" => {
                        stderr_truncated = output.truncated;
                        stderr_bytes = Some(output.bytes);
                    }
                    _ => unreachable!("reader stream names are fixed"),
                }
            }
            Ok((stream, Err(error))) => {
                received += 1;
                let error = reader_error(stream, error, stdout_limit, stderr_limit);
                let overflow_wins = matches!(&error, CaptureError::TooLarge { .. })
                    && !matches!(first_error.as_ref(), Some(CaptureError::TooLarge { .. }));
                if first_error.is_none() || overflow_wins {
                    first_error = Some(error);
                }
                if wait_result.is_none() {
                    wait_result = Some(kill_and_wait(&mut child));
                }
            }
            Err(_) => {
                if first_error.is_none() {
                    first_error = Some(CaptureError::ReaderPanicked { stream: "output" });
                    wait_result = Some(kill_and_wait(&mut child));
                }
                break;
            }
        }
    }

    // On an error the child was killed and waited above, before any join. On a
    // complete capture both readers have observed EOF, so a normal wait cannot
    // deadlock on pipe backpressure.
    let wait_result = wait_result.unwrap_or_else(|| wait_with_reap_retry(&mut child));
    for (stream, handle) in [("stdout", stdout_thread), ("stderr", stderr_thread)] {
        if handle.join().is_err() && first_error.is_none() {
            first_error = Some(CaptureError::ReaderPanicked { stream });
        }
    }

    if let Some(error) = first_error {
        return Err(error);
    }
    let status = wait_result.map_err(CaptureError::Wait)?;
    Ok(BoundedOutput {
        status,
        stdout: stdout_bytes.expect("successful stdout reader sent its complete output"),
        stderr: stderr_bytes.expect("successful stderr reader sent its bounded output"),
        stderr_truncated,
    })
}

fn reader_error(
    stream: &'static str,
    error: ReaderError,
    stdout_limit: usize,
    stderr_limit: usize,
) -> CaptureError {
    match error {
        ReaderError::Read(source) => CaptureError::Read { stream, source },
        ReaderError::Allocate => CaptureError::Allocate { stream },
        ReaderError::TooLarge => CaptureError::TooLarge {
            stream,
            limit: if stream == "stdout" {
                stdout_limit
            } else {
                stderr_limit
            },
        },
        ReaderError::Panicked => CaptureError::ReaderPanicked { stream },
    }
}

fn abort_and_reap(child: &mut Child) {
    let _ = kill_and_wait(child);
}

fn kill_and_wait(child: &mut Child) -> io::Result<ExitStatus> {
    let _ = child.kill();
    wait_with_reap_retry(child)
}

fn wait_with_reap_retry(child: &mut Child) -> io::Result<ExitStatus> {
    match child.wait() {
        Ok(status) => Ok(status),
        Err(first) => {
            // Preserve the wait failure, but still make one final kill/reap
            // attempt before returning ownership to the caller.
            let _ = child.kill();
            let _ = child.wait();
            Err(first)
        }
    }
}
