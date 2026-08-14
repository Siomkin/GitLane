//! Reader-level behaviour: overflow handling, drain accounting, and the way a
//! failing or panicking reader reports.

use std::io::{self, Read};
use std::sync::mpsc;
use std::time::Duration;

use super::super::error::ReaderError;
use super::super::reader::{drain_to_eof_within, read_and_report, spawn_reader, Overflow};

#[test]
fn truncating_overflow_keeps_the_prefix_and_reports_truncation() {
    let mut result = None;
    read_and_report(
        &b"0123456789"[..],
        4,
        Overflow::Truncate { ceiling: 1024 },
        |value| result = Some(value),
    );
    let output = result.expect("reader reports once").expect("not an error");
    assert_eq!(output.bytes, b"0123");
    assert!(output.truncated);
}

#[test]
fn truncating_overflow_escalates_past_the_drain_ceiling() {
    // A stream that keeps producing long after its limit is a runaway, not a
    // verbose one: it must still fail so the parent kills the child rather
    // than draining forever. The excess can arrive in one large read or many
    // small ones — neither may slip past the ceiling.
    for excess in [&vec![b'e'; 4096][..], &vec![b'e'; 20][..]] {
        let mut result = None;
        let mut source = Vec::from(b"0123".as_slice());
        source.extend_from_slice(excess);
        read_and_report(
            DripFeed::new(&source, 8),
            4,
            Overflow::Truncate { ceiling: 8 },
            |value| result = Some(value),
        );
        assert!(
            matches!(result, Some(Err(ReaderError::TooLarge))),
            "{} excess bytes must escalate",
            excess.len()
        );
    }

    let mut single_read = None;
    read_and_report(
        &vec![b'e'; 4096][..],
        4,
        Overflow::Truncate { ceiling: 8 },
        |value| single_read = Some(value),
    );
    assert!(matches!(single_read, Some(Err(ReaderError::TooLarge))));
}

/// A reader that hands back at most `chunk` bytes per call, so drain
/// accounting is exercised across many reads rather than one slice copy.
struct DripFeed {
    data: Vec<u8>,
    cursor: usize,
    chunk: usize,
}

impl DripFeed {
    fn new(data: &[u8], chunk: usize) -> Self {
        Self {
            data: data.to_vec(),
            cursor: 0,
            chunk,
        }
    }
}

impl Read for DripFeed {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let take = self
            .chunk
            .min(buffer.len())
            .min(self.data.len() - self.cursor);
        buffer[..take].copy_from_slice(&self.data[self.cursor..self.cursor + take]);
        self.cursor += take;
        Ok(take)
    }
}

#[test]
fn drain_ceiling_counts_bytes_rather_than_reads() {
    assert!(drain_to_eof_within(&mut &b"12345678"[..], 8));
    assert!(!drain_to_eof_within(&mut &b"123456789"[..], 8));
    assert!(drain_to_eof_within(&mut &b""[..], 0));
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
    read_and_report(
        FailsAfterPartialRead(false),
        1024,
        Overflow::Fail,
        |reported| {
            result = Some(reported);
        },
    );
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
    let handle = spawn_reader("stdout", PanicsOnRead, 1024, Overflow::Fail, tx).unwrap();

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
    let handle = spawn_reader("stdout", OverflowsThenPanics(false), 0, Overflow::Fail, tx).unwrap();

    let (_, first) = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(matches!(first, Err(ReaderError::TooLarge)));
    assert!(handle.join().is_ok(), "the drain panic must be caught");
    assert!(matches!(
        rx.recv_timeout(Duration::from_millis(50)),
        Err(mpsc::RecvTimeoutError::Disconnected)
    ));
}
