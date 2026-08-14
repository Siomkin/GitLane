//! The sign-in flow itself: starting it, waiting for the child, cancelling.

use super::parse::extract_signin_error;
use super::pty::{drive_reader, ReaderShared, PTY_COLS, PTY_ROWS};
use super::slot::{debug_log, SignInSlot};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, ExitStatus, PtySize, PtySystem};
use tauri::AppHandle;

use crate::git::types::GithubSignInResult;

use super::super::domain::{normalize_host, DEFAULT_GITHUB_HOST};

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
    super::super::cli::ensure_supported().map_err(|e| e.to_ipc_string())?;
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
            rows: PTY_ROWS,
            cols: PTY_COLS,
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
            let child = guard.child.as_mut()?; // taken / cancelled
            match child.try_wait() {
                Ok(Some(status)) => {
                    guard.child = None;
                    return Some(status);
                }
                Ok(None) => {} // still running — fall through to the grace check
                Err(_) => {
                    guard.child = None;
                    return None;
                }
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
