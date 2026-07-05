//! Interactive `gh auth login --web` device-flow sign-in (GL-106).
//!
//! Every other `gh` call is one-shot request/response through
//! [`cli::run_gh`](super::cli) — but the web device flow is *interactive*: `gh`
//! prints a one-time code, waits for the user to authorize it in a browser, then
//! completes. `gh` needs a TTY for that flow, so we drive it inside a
//! pseudo-terminal (the same [`portable_pty`] stack the integrated terminal
//! uses), stream the parsed milestones to the webview as `github-signin-progress`
//! events, and park the child in a [`SignInSlot`] so [`cancel_sign_in`] can kill
//! it from another command. Tokens never cross IPC — only the device code, the
//! verification URL, and status steps do; `gh` writes the token to the system
//! credential store itself.

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, CommandBuilder, ExitStatus, PtySize, PtySystem};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::git::types::GithubSignInResult;

use super::domain::{normalize_host, DEFAULT_GITHUB_HOST};

/// One sign-in milestone, emitted to the frontend as a `github-signin-progress`
/// event. `code`/`url` are present only on the initial `"code"` step.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SignInProgress {
    /// `"code"` | `"browser"` | `"authorized"`.
    step: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
}

/// Shared slot for the in-flight sign-in: the running child (so [`cancel_sign_in`]
/// can kill it) plus a sticky `canceled` flag. The flag closes a race — a Cancel
/// can land in the window between [`sign_in_web`] being dispatched and its spawn
/// registering the child, when there is no child to kill yet; the flag lets the
/// spawn abort before it launches gh (and a browser) after the UI backed out.
#[derive(Default)]
pub struct SignInSlotState {
    child: Option<Box<dyn Child + Send + Sync>>,
    canceled: bool,
}

pub type SignInSlot = Arc<Mutex<SignInSlotState>>;

/// Dev-only diagnostics on the `tauri dev` stderr, for debugging the interactive
/// flow. The raw gh output includes the (short-lived) one-time device code, so
/// these must never log in release builds.
fn debug_log(args: std::fmt::Arguments<'_>) {
    #[cfg(debug_assertions)]
    eprintln!("[signin] {args}");
    #[cfg(not(debug_assertions))]
    let _ = args;
}

/// What the PTY reader thread hands back to the main flow: the parsed login (on
/// success) and a bounded transcript tail (for error reporting).
#[derive(Default, Clone)]
struct ReaderShared {
    login: Option<String>,
    transcript: String,
    /// True once gh printed "Authentication complete" / "Logged in as" — at which
    /// point the token is persisted, so the sign-in is effectively done even if gh
    /// then blocks on an optional post-auth prompt.
    authorized: bool,
}

/// Run `gh auth login --web` for `host` inside a PTY, streaming progress.
///
/// Runs on the blocking pool (see `lib::blocking`). Emits `github-signin-progress`
/// as the flow advances (`code` → `browser` → `authorized`) and returns the newly
/// signed-in `{ host, login }` on success so the UI can offer to bind it. On
/// cancel/failure it returns the meaningful `gh` error text.
pub fn sign_in_web(
    app: &AppHandle,
    slot: SignInSlot,
    host: &str,
) -> Result<GithubSignInResult, String> {
    // Respect the gh capability baseline before offering the flow.
    super::cli::ensure_supported().map_err(|e| e.to_ipc_string())?;
    let host = {
        let h = normalize_host(host);
        if h.is_empty() {
            DEFAULT_GITHUB_HOST.to_string()
        } else {
            h
        }
    };

    let pty_system: Box<dyn PtySystem> = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("failed to open pty for sign-in: {e}"))?;

    let mut cmd = CommandBuilder::new("gh");
    for arg in [
        "auth",
        "login",
        "--web",
        "--hostname",
        host.as_str(),
        "--git-protocol",
        "https",
        "--skip-ssh-key",
    ] {
        cmd.arg(arg);
    }
    // macOS GUI apps launch with a minimal PATH that excludes Homebrew's bin dir;
    // use the augmented PATH so `gh` is found (mirrors cli::run_gh).
    cmd.env("PATH", crate::shell::path());
    // `gh auth login` refuses to run while GH_TOKEN / GH_ENTERPRISE_TOKEN is set
    // ("The value of the GH_TOKEN environment variable is being used…"). We never
    // set them globally, but strip them defensively so login is never blocked.
    cmd.env_remove("GH_TOKEN");
    cmd.env_remove("GH_ENTERPRISE_TOKEN");
    cmd.env("TERM", "xterm-256color");
    // The reader matches gh's English prompt text ("one-time code:", "Press
    // Enter", "Authentication complete", …). gh is not localized today and
    // `ensure_supported` pins ≥ 2.95, but pin the locale anyway so a future
    // localized gh can't silently break the parser.
    cmd.env("LC_ALL", "C");
    cmd.env("LANG", "C");

    // Reader + writer come off the master; keep it alive for the whole flow.
    let master = pair.master;
    let reader = master
        .try_clone_reader()
        .map_err(|e| format!("failed to read sign-in output: {e}"))?;
    let writer = master
        .take_writer()
        .map_err(|e| format!("failed to drive sign-in input: {e}"))?;

    // Spawn + park atomically; refuse a second concurrent sign-in (it would orphan
    // the first child and make cancel target the wrong one). Honor a Cancel that
    // raced ahead of the spawn: abort here rather than launch gh + a browser after
    // the UI already returned to configure. The flag is cleared as we consume it so
    // it can never leak into the next sign-in.
    {
        let mut guard = slot.lock().map_err(|e| e.to_string())?;
        if guard.child.is_some() {
            return Err("A GitHub sign-in is already in progress.".to_string());
        }
        if guard.canceled {
            guard.canceled = false;
            return Err("GitHub sign-in canceled.".to_string());
        }
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("failed to launch gh: {e}"))?;
        guard.child = Some(child);
    }
    drop(pair.slave);

    // Parse + drive the interactive prompts on a reader thread. We do NOT wait for
    // the reader to hit EOF: `gh` launches the browser via `open`, which can keep
    // the PTY slave open *after* gh itself exits, so the read would block forever.
    // Completion is driven off gh's real process exit instead (`wait_for_child`).
    let shared = Arc::new(Mutex::new(ReaderShared::default()));
    let reader_app = app.clone();
    let reader_shared = Arc::clone(&shared);
    let reader_host = host.clone();
    let reader_handle = std::thread::spawn(move || {
        drive_reader(&reader_app, reader, writer, &reader_shared, &reader_host)
    });

    debug_log(format_args!("spawned gh, waiting for exit/authorization…"));
    let exited = wait_for_child(&slot, &shared);
    debug_log(format_args!("wait_for_child returned exited={exited:?}"));
    // Give the reader a moment to flush gh's final "Logged in as …" line, then read
    // the parsed result. The reader thread is detached: its blocking read returns
    // once `open`/the browser releases the PTY, so it can't wedge this command.
    std::thread::sleep(Duration::from_millis(150));
    let outcome = shared.lock().map(|g| g.clone()).unwrap_or_default();
    drop(master);
    drop(reader_handle);
    // Leave the slot clean for the next sign-in — the child is already reclaimed;
    // clear any lingering cancel so it can't abort a subsequent run.
    if let Ok(mut guard) = slot.lock() {
        guard.child = None;
        guard.canceled = false;
    }

    // Authorized ⇒ the token is stored, so it's a success even if gh was killed for
    // hanging on a post-auth prompt (or exited non-zero configuring git afterwards).
    let success = outcome.authorized || exited.map(|s| s.success()).unwrap_or(false);
    debug_log(format_args!(
        "done: success={success} authorized={} login={:?}",
        outcome.authorized, outcome.login
    ));
    if success {
        Ok(GithubSignInResult {
            host,
            login: outcome.login.unwrap_or_default(),
        })
    } else {
        Err(extract_signin_error(&outcome.transcript))
    }
}

/// Poll the parked child until it exits (or `cancel_sign_in` kills it), taking it
/// out of the slot once reaped. Polling (rather than a blocking `wait`) lets us
/// finish the moment gh exits even when the PTY hasn't signalled EOF.
///
/// Once gh reports authorization, the token is already persisted — so if gh then
/// blocks on an optional post-auth prompt (git-protocol / credential-helper setup)
/// instead of exiting, kill it after a short grace and return `None` (the caller
/// treats `authorized` as success). Returns the real [`ExitStatus`] when gh exits
/// on its own, or `None` on a grace-kill / emptied slot.
fn wait_for_child(slot: &SignInSlot, shared: &Arc<Mutex<ReaderShared>>) -> Option<ExitStatus> {
    let mut authorized_since: Option<Instant> = None;
    loop {
        std::thread::sleep(Duration::from_millis(60));
        {
            let mut guard = slot.lock().ok()?;
            match guard.child.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        guard.child = None;
                        return Some(status);
                    }
                    Ok(None) => {} // still running — fall through to the grace check
                    Err(_) => {
                        guard.child = None;
                        return None;
                    }
                },
                None => return None, // taken / cancelled
            }
        }
        let authorized = shared.lock().map(|g| g.authorized).unwrap_or(false);
        if authorized {
            match authorized_since {
                None => authorized_since = Some(Instant::now()),
                Some(since) if since.elapsed() >= Duration::from_millis(1500) => {
                    if let Ok(mut guard) = slot.lock() {
                        if let Some(child) = guard.child.as_mut() {
                            let _ = child.kill();
                        }
                        guard.child = None;
                    }
                    return None;
                }
                Some(_) => {}
            }
        }
    }
}

/// Read gh's PTY output to EOF, emitting `github-signin-progress` milestones and
/// answering its prompts (open-browser, git-credential). Stores the parsed login
/// and a transcript tail in `shared` for the main flow to pick up. Runs detached.
fn drive_reader(
    app: &AppHandle,
    mut reader: Box<dyn Read + Send>,
    mut writer: Box<dyn Write + Send>,
    shared: &Arc<Mutex<ReaderShared>>,
    host: &str,
) {
    let mut transcript = String::new();
    let mut buf = [0u8; 4096];
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
                let chunk = strip_ansi(&String::from_utf8_lossy(&buf[..n]));
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

/// Cancel the in-flight sign-in: kill the child if it's already spawned, and set
/// the sticky flag so a spawn still in flight aborts before launching gh. Both
/// are needed — a Cancel can arrive before *or* after the child registers.
pub fn cancel_sign_in(slot: &SignInSlot) -> Result<(), String> {
    if let Ok(mut guard) = slot.lock() {
        guard.canceled = true;
        if let Some(child) = guard.child.as_mut() {
            let _ = child.kill();
        }
    }
    Ok(())
}

fn emit(app: &AppHandle, step: &str, code: Option<String>, url: Option<String>) {
    let _ = app.emit(
        "github-signin-progress",
        SignInProgress {
            step: step.to_string(),
            code,
            url,
        },
    );
}

/// Extract the one-time device code (`XXXX-XXXX`) and the verification URL from
/// gh's output. Returns `None` until the code line has arrived. When the URL
/// hasn't been printed yet, fall back to the flow's own host (not github.com —
/// this may be a GHES sign-in).
fn parse_code(transcript: &str, host: &str) -> Option<(String, String)> {
    let idx = transcript.find("one-time code:")?;
    let code = transcript[idx + "one-time code:".len()..]
        .split_whitespace()
        .find(|t| is_device_code(t))?
        .to_string();
    let url = transcript
        .split_whitespace()
        .find(|t| t.starts_with("https://") && t.contains("/login/device"))
        .map(|t| t.trim_end_matches(['.', ')', ',']).to_string())
        .unwrap_or_else(|| format!("https://{host}/login/device"));
    Some((code, url))
}

/// `gh` device codes are eight alphanumerics split by a hyphen, e.g. `1A2B-3C4D`.
fn is_device_code(token: &str) -> bool {
    let bytes = token.as_bytes();
    bytes.len() == 9
        && bytes[4] == b'-'
        && token[..4].chars().all(|c| c.is_ascii_alphanumeric())
        && token[5..].chars().all(|c| c.is_ascii_alphanumeric())
}

/// Pull the login out of gh's `✓ Logged in as octocat` success line.
fn parse_login(transcript: &str) -> Option<String> {
    let idx = transcript.rfind("Logged in as ")?;
    let login = transcript[idx + "Logged in as ".len()..]
        .split_whitespace()
        .next()?
        .trim()
        .trim_start_matches('@');
    (!login.is_empty()).then(|| login.to_string())
}

/// Best-effort failure text: the last line mentioning an error, else a generic
/// message so the UI never shows an empty failure.
fn extract_signin_error(transcript: &str) -> String {
    transcript
        .lines()
        .map(str::trim)
        .filter(|l| {
            let low = l.to_lowercase();
            low.contains("error") || low.contains("failed") || low.contains("could not")
        })
        .last()
        .map(|l| {
            l.trim_start_matches(['x', '✗', '!', '-', ' '])
                .trim()
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "GitHub sign-in didn’t complete. Please try again.".to_string())
}

/// Strip ANSI/CSI escape sequences so parsing sees plain text (gh styles some of
/// its prompts). Best-effort: drops `ESC [ … <letter>` runs and any lone `ESC x`.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                while let Some(&n) = chars.peek() {
                    chars.next();
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            } else {
                chars.next();
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Keep the transcript bounded (~16 KiB) on a char boundary — the device flow can
/// stream a lot before it completes, but we only ever scan for a few markers.
fn bound_transcript(transcript: &mut String) {
    const CAP: usize = 16 * 1024;
    if transcript.len() > CAP {
        let cut = transcript.len() - CAP;
        let start = (cut..transcript.len())
            .find(|&i| transcript.is_char_boundary(i))
            .unwrap_or(transcript.len());
        *transcript = transcript[start..].to_string();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
