//! Inline tests for the output parsing.

use super::flow::cancel_sign_in;
use super::parse::*;
use super::probes::TerminalProbes;
use super::pty::{PTY_COLS, PTY_ROWS};
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
