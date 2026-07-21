//! Concurrent, hard-bounded output capture for provider CLI children.
//!
//! Reading one pipe to completion before the other can deadlock when a child
//! fills the unattended pipe. Provider CLIs also return remote-controlled JSON
//! and patch text, so `Command::output`'s unbounded buffers are not appropriate
//! at this boundary. This module drains both streams concurrently, never retains
//! more than the configured limits, and kills then reaps the direct child if
//! either reader cannot produce a complete bounded result. It deliberately does
//! not manage a process tree: a descendant that inherits a pipe handle can delay
//! reader EOF after the direct child exits. Provider CLIs are expected not to
//! leave such descendants behind.

use std::fmt;
use std::io::{self, Read};
use std::panic::{self, AssertUnwindSafe};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread::{self, JoinHandle};

pub(super) const DEFAULT_STDOUT_LIMIT: usize = 4 * 1024 * 1024;
pub(super) const DIFF_STDOUT_LIMIT: usize = 32 * 1024 * 1024;
pub(super) const STDERR_LIMIT: usize = 1024 * 1024;

const READ_CHUNK: usize = 16 * 1024;
const INITIAL_CAPACITY: usize = 64 * 1024;

#[derive(Debug)]
pub(super) struct BoundedOutput {
    pub(super) status: ExitStatus,
    pub(super) stdout: Vec<u8>,
    pub(super) stderr: Vec<u8>,
}

#[derive(Debug)]
pub(super) enum CaptureError {
    Spawn(io::Error),
    ReaderStart {
        stream: &'static str,
        source: io::Error,
    },
    Read {
        stream: &'static str,
        source: io::Error,
    },
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
enum ReaderError {
    Read(io::Error),
    Allocate,
    TooLarge,
    Panicked,
}

type ReaderResult = Result<Vec<u8>, ReaderError>;

/// Spawn `command`, drain both pipes concurrently, and return only complete
/// output within both limits. Every successfully spawned child is waited on.
pub(super) fn capture(
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
    let stdout_thread = match spawn_reader("stdout", stdout, stdout_limit, tx.clone()) {
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
    let stderr_thread = match spawn_reader("stderr", stderr, stderr_limit, tx.clone()) {
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
    let mut first_error = None;
    let mut received = 0;
    let mut wait_result = None;
    while received < 2 {
        match rx.recv() {
            Ok((stream, Ok(bytes))) => {
                received += 1;
                match stream {
                    "stdout" => stdout_bytes = Some(bytes),
                    "stderr" => stderr_bytes = Some(bytes),
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
        stderr: stderr_bytes.expect("successful stderr reader sent its complete output"),
    })
}

fn spawn_reader<R: Read + Send + 'static>(
    stream: &'static str,
    reader: R,
    limit: usize,
    tx: mpsc::Sender<(&'static str, ReaderResult)>,
) -> io::Result<JoinHandle<()>> {
    thread::Builder::new()
        .name(format!("gitlane-{stream}-reader"))
        .spawn(move || {
            let mut reported = false;
            let unwind = panic::catch_unwind(AssertUnwindSafe(|| {
                read_and_report(reader, limit, |result| {
                    reported = true;
                    let _ = tx.send((stream, result));
                });
            }));
            if unwind.is_err() && !reported {
                let _ = tx.send((stream, Err(ReaderError::Panicked)));
            }
        })
}

/// Report overflow as soon as the first excess byte arrives, then keep the pipe
/// draining without retaining more data. The parent kills and waits immediately
/// on that report; continuing to read until EOF prevents a full pipe from
/// blocking process teardown in the meantime.
fn read_and_report(mut reader: impl Read, limit: usize, report: impl FnOnce(ReaderResult)) {
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
                Ok(0) => report(Ok(output)),
                Ok(_) => {
                    report(Err(ReaderError::TooLarge));
                    drain_to_eof(&mut reader);
                }
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
            report(Ok(output));
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{Duration, Instant};

    const CHILD_MODE: &str = "GITLANE_BOUNDED_OUTPUT_CHILD_MODE";
    const CHILD_SIZE: &str = "GITLANE_BOUNDED_OUTPUT_CHILD_SIZE";

    #[test]
    fn fake_cli_child() {
        let Ok(mode) = std::env::var(CHILD_MODE) else {
            return;
        };
        let size = std::env::var(CHILD_SIZE)
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);

        match mode.as_str() {
            "stdout" => write_bytes(std::io::stdout(), b'o', size),
            "stderr" => write_bytes(std::io::stderr(), b'e', size),
            "both" => {
                install_child_watchdog();
                write_bytes(std::io::stdout(), b'o', size);
                write_bytes(std::io::stderr(), b'e', size);
            }
            "overflow-sleep" => {
                install_child_watchdog();
                write_bytes(std::io::stdout(), b'o', size);
                std::thread::sleep(Duration::from_secs(30));
            }
            "exit" => {
                std::io::stdout().write_all(b"stdout").unwrap();
                std::io::stderr().write_all(b"stderr").unwrap();
                std::process::exit(7);
            }
            other => panic!("unknown fake child mode {other}"),
        }
        std::process::exit(0);
    }

    fn install_child_watchdog() {
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(8));
            std::process::exit(98);
        });
    }

    fn write_bytes(mut writer: impl Write, byte: u8, size: usize) {
        let chunk = [byte; 8192];
        let mut remaining = size;
        while remaining > 0 {
            let count = remaining.min(chunk.len());
            writer.write_all(&chunk[..count]).unwrap();
            remaining -= count;
        }
        writer.flush().unwrap();
    }

    fn fake_command(mode: &str, size: usize) -> Command {
        let mut command = Command::new(std::env::current_exe().expect("current test executable"));
        command
            .args([
                "--exact",
                "git::github::bounded_output::tests::fake_cli_child",
                "--quiet",
            ])
            .env(CHILD_MODE, mode)
            .env(CHILD_SIZE, size.to_string());
        command
    }

    fn child_stdout_prefix() -> Vec<u8> {
        // libtest writes a small platform-dependent prefix before invoking the
        // selected test. Capture it dynamically so byte-limit assertions stay
        // exact across harness versions and newline conventions.
        capture(&mut fake_command("stdout", 0), 1024, 1024)
            .unwrap()
            .stdout
    }

    #[test]
    fn configured_caps_match_the_provider_contract() {
        assert_eq!(DEFAULT_STDOUT_LIMIT, 4 * 1024 * 1024);
        assert_eq!(DIFF_STDOUT_LIMIT, 32 * 1024 * 1024);
        assert_eq!(STDERR_LIMIT, 1024 * 1024);
    }

    #[test]
    fn accepts_the_exact_stdout_limit() {
        let prefix = child_stdout_prefix();
        let payload_size = 4096;
        let limit = prefix.len() + payload_size;
        let output = capture(&mut fake_command("stdout", payload_size), limit, 1024).unwrap();
        assert!(output.status.success());
        assert!(output.stdout.starts_with(&prefix));
        assert_eq!(&output.stdout[prefix.len()..], vec![b'o'; payload_size]);
        assert!(output.stderr.is_empty());
    }

    #[test]
    fn accepts_the_exact_stderr_limit() {
        let prefix = child_stdout_prefix();
        let limit = 4096;
        let output = capture(&mut fake_command("stderr", limit), prefix.len(), limit).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, prefix);
        assert_eq!(output.stderr, vec![b'e'; limit]);
    }

    #[test]
    fn rejects_limit_plus_one_without_partial_output() {
        let prefix = child_stdout_prefix();
        let payload_size = 4096;
        let limit = prefix.len() + payload_size - 1;
        let error = capture(&mut fake_command("stdout", payload_size), limit, 1024).unwrap_err();
        assert!(matches!(
            error,
            CaptureError::TooLarge {
                stream: "stdout",
                limit: reported
            } if reported == limit
        ));
    }

    #[test]
    fn drains_stdout_and_stderr_concurrently() {
        // This exceeds ordinary pipe capacity on every supported platform. A
        // stdout-to-EOF-then-stderr implementation deadlocks here because the
        // child fills stderr before it can close stdout.
        let prefix = child_stdout_prefix();
        let payload_size = 512 * 1024;
        let stdout_limit = prefix.len() + payload_size;
        let output = capture(
            &mut fake_command("both", payload_size),
            stdout_limit,
            payload_size,
        )
        .unwrap();
        assert!(output.stdout.starts_with(&prefix));
        assert_eq!(&output.stdout[prefix.len()..], vec![b'o'; payload_size]);
        assert_eq!(output.stderr, vec![b'e'; payload_size]);
    }

    #[test]
    fn overflow_kills_and_reaps_a_still_running_child() {
        let limit = 4096;
        let started = Instant::now();
        let error =
            capture(&mut fake_command("overflow-sleep", limit + 1), limit, 1024).unwrap_err();

        assert!(matches!(
            error,
            CaptureError::TooLarge {
                stream: "stdout",
                ..
            }
        ));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "overflow must kill rather than wait for the child sleep"
        );
    }

    #[test]
    fn enforces_the_stderr_cap() {
        let limit = 2048;
        let error = capture(&mut fake_command("stderr", limit + 1), 4096, limit).unwrap_err();
        assert!(matches!(
            error,
            CaptureError::TooLarge {
                stream: "stderr",
                limit: 2048
            }
        ));
    }

    #[test]
    fn preserves_exit_status_and_stream_identity() {
        let prefix = child_stdout_prefix();
        let output = capture(&mut fake_command("exit", 0), 1024, 1024).unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.starts_with(&prefix));
        assert_eq!(&output.stdout[prefix.len()..], b"stdout");
        assert_eq!(output.stderr, b"stderr");
    }

    #[test]
    fn missing_cli_is_reported_as_a_not_found_spawn() {
        let mut command = Command::new("gitlane-provider-cli-that-does-not-exist-321");
        let error = capture(&mut command, 1024, 1024).unwrap_err();
        assert!(matches!(
            error,
            CaptureError::Spawn(source) if source.kind() == io::ErrorKind::NotFound
        ));
    }

    struct FailsAfterPartialRead(bool);

    impl Read for FailsAfterPartialRead {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if self.0 {
                Err(io::Error::other("scripted reader failure"))
            } else {
                self.0 = true;
                buffer[..7].copy_from_slice(b"partial");
                Ok(7)
            }
        }
    }

    #[test]
    fn reader_failure_returns_no_partial_bytes() {
        let mut result = None;
        read_and_report(FailsAfterPartialRead(false), 1024, |reported| {
            result = Some(reported);
        });
        assert!(matches!(
            result,
            Some(Err(ReaderError::Read(source)))
                if source.to_string() == "scripted reader failure"
        ));
    }

    struct PanicsOnRead;

    impl Read for PanicsOnRead {
        fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
            panic!("scripted reader panic")
        }
    }

    #[test]
    fn reader_panic_is_reported_while_a_sibling_sender_stays_alive() {
        let (tx, rx) = mpsc::channel();
        let sibling_sender = tx.clone();
        let handle = spawn_reader("stdout", PanicsOnRead, 1024, tx).unwrap();

        let (stream, result) = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("the panicking worker must report without channel disconnect");
        assert_eq!(stream, "stdout");
        assert!(matches!(result, Err(ReaderError::Panicked)));

        drop(sibling_sender);
        assert!(
            handle.join().is_ok(),
            "the panic must be caught in the worker"
        );
    }

    struct OverflowsThenPanics(bool);

    impl Read for OverflowsThenPanics {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if self.0 {
                panic!("scripted drain panic")
            }
            self.0 = true;
            buffer[0] = b'x';
            Ok(1)
        }
    }

    #[test]
    fn panic_after_overflow_does_not_report_twice() {
        let (tx, rx) = mpsc::channel();
        let handle = spawn_reader("stdout", OverflowsThenPanics(false), 0, tx).unwrap();

        let (_, first) = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(matches!(first, Err(ReaderError::TooLarge)));
        assert!(handle.join().is_ok(), "the drain panic must be caught");
        assert!(matches!(
            rx.recv_timeout(Duration::from_millis(50)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        ));
    }
}
