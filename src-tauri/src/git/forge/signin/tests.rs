//! Tests for the output parsing and the PTY reader's milestone sequence.

use super::flow::cancel_sign_in;
use super::parse::*;
use super::probes::TerminalProbes;
use super::pty::{drive_reader, ReaderShared, PTY_COLS, PTY_ROWS};
use super::slot::{SignInSlot, SignInSlotState};
use std::sync::{Arc, Mutex};

#[test]
fn parses_code_and_url() {
    let t = "! First copy your one-time code: 1A2B-3C4D\nPress Enter to open https://github.com/login/device in your browser...";
    let (code, url) = parse_code(t, "github.com").unwrap();
    assert_eq!(code, "1A2B-3C4D");
    assert_eq!(url, "https://github.com/login/device");
}

#[test]
fn code_url_falls_back_to_the_flow_host() {
    // Code line arrived but the URL hasn't been printed yet — the fallback
    // must point at the sign-in host, not hardcode github.com (GHES).
    let t = "! First copy your one-time code: 1A2B-3C4D\n";
    let (_, url) = parse_code(t, "github.acme.com").unwrap();
    assert_eq!(url, "https://github.acme.com/login/device");
}

#[test]
fn code_requires_full_pattern() {
    assert!(is_device_code("1A2B-3C4D"));
    assert!(!is_device_code("1A2B3C4D"));
    assert!(!is_device_code("1A2-3C4D"));
    assert!(!is_device_code("short"));
    assert!(parse_code("no code here yet", "github.com").is_none());
}

#[test]
fn parses_login_from_success_line() {
    assert_eq!(
        parse_login("✓ Authentication complete.\n✓ Logged in as octocat\n").as_deref(),
        Some("octocat")
    );
    assert_eq!(
        parse_login("Logged in as @dana-work").as_deref(),
        Some("dana-work")
    );
    assert!(parse_login("still waiting").is_none());
}

#[test]
fn strips_ansi_before_matching() {
    let raw = "\u{1b}[1m! First copy your one-time code:\u{1b}[0m ABCD-1234";
    let clean = strip_ansi(raw);
    assert!(parse_code(&clean, "github.com").is_some());
}

#[test]
fn strips_osc_queries_out_of_the_transcript() {
    // The TUI's background-colour query must not leak its `11;?` payload into
    // the text we scan for prompt markers.
    let raw = "\u{1b}]11;?\u{1b}\\\u{1b}[0;1;92m? \u{1b}[0mAuthenticate Git";
    assert_eq!(strip_ansi(raw), "? Authenticate Git");
    assert_eq!(strip_ansi("\u{1b}]11;?\u{7}done"), "done");
}

/// The regression this file exists to prevent: gh's Bubble Tea prompts block on
/// these probes, so an unanswered one means no code and an infinite spinner.
#[test]
fn answers_the_probes_gh_blocks_on() {
    let mut probes = TerminalProbes::default();
    let mut out: Vec<u8> = Vec::new();
    probes.answer("\u{1b}]11;?\u{1b}\\\u{1b}[6n", &mut out);
    let replies = String::from_utf8(out).unwrap();
    assert!(
        replies.contains("\u{1b}]11;rgb:"),
        "background query unanswered"
    );
    assert!(replies.ends_with("\u{1b}[1;1R"), "cursor report unanswered");
}

#[test]
fn the_sizing_probe_reports_the_pty_size() {
    // `ESC[999;999f` then a DSR is gh measuring the window: it must get back the
    // PTY's real size, not a cursor position.
    let mut probes = TerminalProbes::default();
    let mut out: Vec<u8> = Vec::new();
    probes.answer("\u{1b}7\u{1b}[999;999f\u{1b}[6n", &mut out);
    assert_eq!(
        String::from_utf8(out).unwrap(),
        format!("\u{1b}[{PTY_ROWS};{PTY_COLS}R")
    );
}

#[test]
fn a_probe_split_across_reads_is_still_answered() {
    // 4 KiB reads land wherever they land; a probe cut in half must not be lost.
    let mut probes = TerminalProbes::default();
    let mut out: Vec<u8> = Vec::new();
    probes.answer("credentials? (Y/n) \u{1b}[6", &mut out);
    assert!(out.is_empty(), "answered a half-read probe");
    probes.answer("n", &mut out);
    assert_eq!(String::from_utf8(out).unwrap(), "\u{1b}[1;1R");
}

#[test]
fn ordinary_styling_is_never_mistaken_for_a_probe() {
    let mut probes = TerminalProbes::default();
    let mut out: Vec<u8> = Vec::new();
    probes.answer(
        "\u{1b}[0;1;92m? \u{1b}[0mAuthenticate\u{1b}[0m\r\n",
        &mut out,
    );
    assert!(out.is_empty(), "replied to plain SGR styling");
    assert!(probes.carry.is_empty(), "retained non-probe bytes");
}

#[test]
fn error_prefers_meaningful_lines() {
    let t = "Opening browser…\nerror: could not prompt: EOF\n";
    assert_eq!(extract_signin_error(t), "error: could not prompt: EOF");
    assert!(!extract_signin_error("nothing useful").is_empty());
}

#[test]
fn cancel_is_recorded_even_before_a_child_is_spawned() {
    // The race the flag closes: a Cancel that locks the slot before sign_in_web
    // has parked its child must still be honored, so the pending spawn aborts
    // instead of launching gh (and a browser) after the UI backed out.
    let slot: SignInSlot = Arc::new(Mutex::new(SignInSlotState::default()));
    cancel_sign_in(&slot).unwrap();
    assert!(slot.lock().unwrap().canceled);
}

#[test]
fn bound_transcript_is_char_safe() {
    let mut t = "é".repeat(20_000);
    bound_transcript(&mut t);
    assert!(t.len() <= 16 * 1024 + 8);
    assert!(t.is_char_boundary(0));
}

/// Hands `drive_reader` one chunk per `read`, the way a PTY delivers gh's output
/// in bursts — so milestones are tested across reads, not in one lucky buffer.
struct ChunkedReader(std::collections::VecDeque<Vec<u8>>);

impl std::io::Read for ChunkedReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let Some(chunk) = self.0.pop_front() else {
            return Ok(0);
        };
        let n = chunk.len().min(buf.len());
        buf[..n].copy_from_slice(&chunk[..n]);
        Ok(n)
    }
}

/// Run the reader over `chunks`; return the steps it reported and what it parsed.
fn drive(chunks: &[&str]) -> (Vec<crate::events::SignInProgress>, ReaderShared) {
    let reported = Mutex::new(Vec::new());
    let progress = |p: &crate::events::SignInProgress| reported.lock().unwrap().push(p.clone());
    let reader = ChunkedReader(chunks.iter().map(|c| c.as_bytes().to_vec()).collect());
    let shared = Arc::new(Mutex::new(ReaderShared::default()));

    drive_reader(
        &progress,
        Box::new(reader),
        Box::new(Vec::new()),
        &shared,
        "github.com",
    );

    let outcome = shared.lock().unwrap().clone();
    (reported.into_inner().unwrap(), outcome)
}

#[test]
fn the_reader_reports_code_browser_authorized_once_each_in_order() {
    let (reported, outcome) = drive(&[
        "! First copy your one-time code: 1A2B-3C4D\n",
        "Press Enter to open https://github.com/login/device in your browser...\n",
        // gh can reprint the prompt; the UI must not see a second code or browser step.
        "! First copy your one-time code: 1A2B-3C4D\n",
        "Press Enter to open https://github.com/login/device in your browser...\n",
        "✓ Authentication complete.\n",
        "✓ Logged in as octocat\n",
    ]);

    let steps: Vec<&str> = reported.iter().map(|p| p.step.as_str()).collect();
    assert_eq!(steps, ["code", "browser", "authorized"]);
    assert_eq!(reported[0].code.as_deref(), Some("1A2B-3C4D"));
    assert_eq!(
        reported[0].url.as_deref(),
        Some("https://github.com/login/device")
    );
    assert!(outcome.authorized);
    assert_eq!(outcome.login.as_deref(), Some("octocat"));
}

#[test]
fn the_reader_reports_no_browser_step_before_a_code() {
    // "Press Enter" alone is not the device prompt — without a code there is
    // nothing for the user to type, so the browser step must wait for one.
    let (reported, outcome) = drive(&["Press Enter to continue\n", "some other output\n"]);

    assert!(reported.is_empty());
    assert!(!outcome.authorized);
}
