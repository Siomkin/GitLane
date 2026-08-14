//! Driving `gh auth login` under a pseudo-terminal — the geometry it is
//! given, and the reader thread that pumps its output.

use super::parse::{bound_transcript, parse_code, parse_login, strip_ansi};
use super::probes::TerminalProbes;
use super::slot::{debug_log, emit};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use tauri::AppHandle;

/// Size of the PTY we drive `gh` in — also what we report back when its TUI
/// probes for the window size (see [`TerminalProbes`]).
pub(super) const PTY_ROWS: u16 = 24;

pub(super) const PTY_COLS: u16 = 120;

/// What the PTY reader thread hands back to the main flow: the parsed login (on
/// success) and a bounded transcript tail (for error reporting).
#[derive(Default, Clone)]
pub(super) struct ReaderShared {
    pub(super) login: Option<String>,
    pub(super) transcript: String,
    /// True once gh printed "Authentication complete" / "Logged in as" — at which
    /// point the token is persisted, so the sign-in is effectively done even if gh
    /// then blocks on an optional post-auth prompt.
    pub(super) authorized: bool,
}

/// Read gh's PTY output to EOF, emitting `github-signin-progress` milestones and
/// answering its prompts (open-browser, git-credential). Stores the parsed login
/// and a transcript tail in `shared` for the main flow to pick up. Runs detached.
pub(super) fn drive_reader(
    app: &AppHandle,
    mut reader: Box<dyn Read + Send>,
    mut writer: Box<dyn Write + Send>,
    shared: &Arc<Mutex<ReaderShared>>,
    host: &str,
) {
    let mut transcript = String::new();
    let mut buf = [0u8; 4096];
    let mut probes = TerminalProbes::default();
    let mut reauth_answered = false;
    let mut code_seen = false;
    let mut enter_sent = false;
    let mut browser_emitted = false;
    let mut git_prompt_answered = false;
    let mut authorized_emitted = false;

    loop {
        match reader.read(&mut buf) {
            Ok(0) => {
                debug_log(format_args!("gh: <EOF>"));
                break; // EOF — the PTY finally closed.
            }
            Ok(n) => {
                let raw = String::from_utf8_lossy(&buf[..n]);
                // Answer the TUI's terminal probes *first*: until the handshake
                // completes gh's prompts ignore every keystroke we send below.
                probes.answer(&raw, &mut *writer);
                let chunk = strip_ansi(&raw);
                debug_log(format_args!("gh: {chunk:?}"));
                transcript.push_str(&chunk);
                bound_transcript(&mut transcript);

                // When an account for this host already exists, gh asks
                // "…already logged in… Do you want to re-authenticate?" before it
                // prints a code. Answer yes so the device flow proceeds (the user
                // clicked Sign in precisely to authenticate).
                if !reauth_answered && transcript.to_lowercase().contains("re-authenticate") {
                    reauth_answered = true;
                    let _ = writer.write_all(b"y\r");
                    let _ = writer.flush();
                }

                if !code_seen {
                    if let Some((code, url)) = parse_code(&transcript, host) {
                        code_seen = true;
                        emit(app, "code", Some(code), Some(url));
                    }
                }
                // gh waits on "Press Enter to open … in your browser"; answering it
                // is what actually launches the browser, so drive it for the user.
                if code_seen && !enter_sent && transcript.contains("Press Enter") {
                    enter_sent = true;
                    let _ = writer.write_all(b"\r");
                    let _ = writer.flush();
                }
                if enter_sent && !browser_emitted {
                    browser_emitted = true;
                    emit(app, "browser", None, None);
                }
                // Some gh paths still ask whether to set up the git credential
                // helper; accept the default so the flow never stalls.
                if !git_prompt_answered
                    && transcript.contains("Authenticate Git with your GitHub credentials")
                {
                    git_prompt_answered = true;
                    let _ = writer.write_all(b"\r");
                    let _ = writer.flush();
                }
                if !authorized_emitted
                    && (transcript.contains("Authentication complete")
                        || transcript.contains("Logged in as"))
                {
                    authorized_emitted = true;
                    debug_log(format_args!("authorized marker seen"));
                    emit(app, "authorized", None, None);
                }

                if let Ok(mut g) = shared.lock() {
                    if g.login.is_none() {
                        g.login = parse_login(&transcript);
                    }
                    if authorized_emitted {
                        g.authorized = true;
                    }
                    g.transcript = transcript.clone();
                }
            }
            Err(_) => break,
        }
    }
    if let Ok(mut g) = shared.lock() {
        if g.login.is_none() {
            g.login = parse_login(&transcript);
        }
        g.transcript = transcript;
    }
}
