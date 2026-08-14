//! The terminal capability probes `gh` writes on startup, and the replies
//! that keep it from waiting on a terminal that will never answer.

use super::pty::{PTY_COLS, PTY_ROWS};
use std::io::Write;

/// `ESC[6n` — device status report: "where is the cursor?".
pub(super) const DSR_CURSOR: &str = "\u{1b}[6n";

/// `ESC[999;999f` — park the cursor far off-screen so the DSR that follows reports
/// the clamped position, i.e. the window size.
pub(super) const CURSOR_TO_LIMIT: &str = "\u{1b}[999;999f";

/// `ESC]11;?` — OSC 11: "what is your background colour?".
pub(super) const OSC_BACKGROUND: &str = "\u{1b}]11;?";

/// Every probe we know how to answer. Order matters only for prefix matching.
pub(super) const PROBES: [&str; 3] = [CURSOR_TO_LIMIT, DSR_CURSOR, OSC_BACKGROUND];

/// Answers the terminal probes gh's TUI prompts expect an emulator to reply to.
///
/// gh ≥ 2.96 renders its confirm prompts ("Authenticate Git with your GitHub
/// credentials?") with a Bubble Tea TUI. On start it probes the terminal — an
/// OSC 11 background-colour query plus `ESC[6n` cursor reports, one of them
/// preceded by a move to 999;999 to measure the window — and it will **not read a
/// single keystroke until those replies come back**. A bare PTY has no emulator on
/// the master end, so nothing answers: gh parks on the credentials prompt forever,
/// the `\r` below is swallowed, no one-time code is ever printed, and the sign-in
/// dialog spins on "Requesting a one-time code…" forever. The integrated terminal
/// never hit this because xterm.js answers the probes for it.
///
/// So answer them here. The values need only be *plausible* — the TUI just needs
/// the handshake to complete before it starts reading input.
#[derive(Default)]
pub(super) struct TerminalProbes {
    /// A probe split across two reads, carried until its tail arrives.
    pub(super) carry: String,
    /// `ESC[999;999f` was seen, so the next `ESC[6n` is asking for the size.
    pub(super) sizing: bool,
}

impl TerminalProbes {
    /// Feed one raw (un-stripped) chunk of gh's output and reply to any probe in it.
    pub(super) fn answer(&mut self, raw: &str, writer: &mut dyn Write) {
        self.carry.push_str(raw);
        let mut reply = String::new();
        let mut cut = 0;
        loop {
            // No escape left in the tail — there is nothing to carry over.
            let Some(rel) = self.carry[cut..].find('\u{1b}') else {
                cut = self.carry.len();
                break;
            };
            let at = cut + rel;
            let rest = &self.carry[at..];
            if let Some(probe) = PROBES.iter().find(|p| rest.starts_with(**p)) {
                match *probe {
                    CURSOR_TO_LIMIT => self.sizing = true,
                    DSR_CURSOR if std::mem::take(&mut self.sizing) => {
                        reply.push_str(&format!("\u{1b}[{PTY_ROWS};{PTY_COLS}R"));
                    }
                    DSR_CURSOR => reply.push_str("\u{1b}[1;1R"),
                    _ => reply.push_str("\u{1b}]11;rgb:1e1e/1e1e/1e1e\u{1b}\\"),
                }
                cut = at + probe.len();
            } else if PROBES.iter().any(|p| p.starts_with(rest)) {
                cut = at; // a probe split across reads — keep it for the next chunk
                break;
            } else {
                cut = at + 1; // some other escape sequence — not ours to answer
            }
        }
        self.carry.drain(..cut);
        if !reply.is_empty() {
            let _ = writer.write_all(reply.as_bytes());
            let _ = writer.flush();
        }
    }
}
