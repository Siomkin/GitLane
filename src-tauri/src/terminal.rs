//! In-app integrated terminal backed by pseudo-terminals (PTYs).
//!
//! Each PTY runs the user's login shell with cwd = a repo; xterm.js on the
//! frontend renders the output and sends keystrokes back. Many PTYs run at once
//! — the frontend keeps one per terminal tab and per repo, so switching repos or
//! tabs never kills a shell (sessions are keyed by `session_id`). The launchable
//! agent entries (opencode / kimi / claude / codex, plus anything the user adds)
//! live in [`crate::terminal_agents`] — they aren't separate processes, they're
//! typed into a shell as a command, so the user keeps full interactive control
//! and the agent inherits the repo's environment.
//!
//! Mirrors the watcher's state + events pattern: `TerminalState` is managed by
//! Tauri, each session's reader thread emits `pty-data` (and `pty-exit`) events
//! tagged with its `session_id`, and the frontend calls
//! `pty_write` / `pty_resize` / `pty_kill` with that id.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize, PtySystem};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
#[cfg(unix)]
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnResponse {
    pub session_id: u64,
}

/// One live PTY session. `master` drives resize; `writer` sends bytes; `child`
/// is explicitly signalled on close.
struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send>,
}

/// All live PTY sessions, keyed by a monotonic `session_id`. The frontend keeps
/// one entry per terminal tab (per repo), so several shells coexist.
struct Terminals {
    sessions: HashMap<u64, Session>,
    next_session_id: u64,
}

/// Managed by Tauri. `Arc` so a session's reader thread can clone a handle and
/// remove itself from the map when its shell exits; `Mutex` keeps spawn/kill
/// atomic.
#[derive(Clone)]
pub struct TerminalState {
    inner: Arc<Mutex<Terminals>>,
}

impl Default for TerminalState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Terminals {
                sessions: HashMap::new(),
                next_session_id: 1,
            })),
        }
    }
}

#[cfg(windows)]
fn shell_command() -> (String, Vec<String>) {
    (
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string()),
        Vec::new(),
    )
}

#[cfg(not(windows))]
fn shell_command() -> (String, Vec<String>) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| {
        if Path::new("/bin/zsh").exists() {
            "/bin/zsh".to_string()
        } else {
            "/bin/sh".to_string()
        }
    });
    (shell, vec!["-l".to_string()])
}

/// Spawn a PTY: open a pseudo-terminal, start the user's login shell in `path`,
/// and kick off a reader thread that streams output to the frontend until the
/// shell exits. Adds a new session — existing sessions are left running.
pub fn spawn(
    state: &TerminalState,
    app: &AppHandle,
    path: &str,
    cols: u16,
    rows: u16,
) -> Result<PtySpawnResponse, String> {
    let pty_system: Box<dyn PtySystem> = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("failed to open pty: {e}"))?;

    // Resolve the user's shell and run it as a login shell where the platform
    // supports that convention, so agents inherit the repo environment.
    let (shell, args) = shell_command();
    let mut cmd = CommandBuilder::new(&shell);
    for arg in args {
        cmd.arg(arg);
    }
    cmd.cwd(path);
    cmd.env("TERM", "xterm-256color");
    // CommandBuilder inherits the parent environment by default, so PATH and
    // extras the user relies on (nvm, brew, etc.) are available inside the shell.

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to spawn shell: {e}"))?;

    // The slave handle is no longer needed once the child is spawned.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("failed to clone pty reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("failed to take pty writer: {e}"))?;

    // Register the new session alongside any others already running.
    let session_id = {
        let mut terminals = state.inner.lock().map_err(|e| e.to_string())?;
        let session_id = terminals.next_session_id;
        terminals.next_session_id = terminals.next_session_id.saturating_add(1);
        terminals.sessions.insert(
            session_id,
            Session {
                master: pair.master,
                writer,
                child,
            },
        );
        session_id
    };

    // Stream PTY output to the frontend until EOF (shell exit). Runs on its own
    // thread; emits raw bytes as `pty-data`, then a final `pty-exit`. On exit it
    // drops its own map entry so a shell that `exit`s self-cleans (the writer
    // handle is also released, letting the child be reaped).
    let app_for_thread = app.clone();
    let inner_for_thread = Arc::clone(&state.inner);
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — shell closed the PTY.
                Ok(n) => {
                    crate::events::emit(
                        &app_for_thread,
                        crate::events::PTY_DATA,
                        crate::events::PtyDataEvent {
                            session_id,
                            data: buf[..n].to_vec(),
                        },
                    );
                }
                Err(_) => break,
            }
        }
        if let Ok(mut terminals) = inner_for_thread.lock() {
            terminals.sessions.remove(&session_id);
        }
        crate::events::emit(
            &app_for_thread,
            crate::events::PTY_EXIT,
            crate::events::PtyExitEvent { session_id },
        );
    });

    Ok(PtySpawnResponse { session_id })
}

/// Forward `data` (user keystrokes from xterm.js) to session `session_id`'s stdin.
pub fn write(state: &TerminalState, session_id: u64, data: &[u8]) -> Result<(), String> {
    let mut terminals = state.inner.lock().map_err(|e| e.to_string())?;
    let session = terminals
        .sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("terminal {session_id} is not running"))?;
    session
        .writer
        .write_all(data)
        .map_err(|e| format!("failed to write to pty: {e}"))?;
    session
        .writer
        .flush()
        .map_err(|e| format!("failed to flush pty: {e}"))?;
    Ok(())
}

/// Resize session `session_id`'s PTY to match the xterm.js viewport (cols/rows).
pub fn resize(state: &TerminalState, session_id: u64, cols: u16, rows: u16) -> Result<(), String> {
    let terminals = state.inner.lock().map_err(|e| e.to_string())?;
    let session = terminals
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("terminal {session_id} is not running"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("failed to resize pty: {e}"))
}

/// Kill one shell and drop its session. Called when the user closes that tab.
/// Removes the session under the lock, then signals the child *after* releasing
/// it, so a slow-to-die shell can't stall spawns/writes/kills on other tabs. The
/// handle is dropped even if the process ignores the signal so the UI recovers.
pub fn kill(state: &TerminalState, session_id: u64) -> Result<(), String> {
    let session = {
        let mut terminals = state.inner.lock().map_err(|e| e.to_string())?;
        terminals.sessions.remove(&session_id)
    };
    match session {
        Some(mut session) => session
            .child
            .kill()
            .map_err(|e| format!("failed to kill pty child: {e}")),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend closes a tab optimistically, so a kill can race the shell
    /// exiting on its own and arrive for a session that is already gone. That
    /// is a no-op, not an error — otherwise closing a finished tab reports a
    /// failure to the user.
    #[test]
    fn killing_a_session_that_is_not_running_succeeds() {
        let state = TerminalState::default();

        assert!(kill(&state, 999).is_ok());
        // Idempotent: a second close of the same tab behaves the same.
        assert!(kill(&state, 999).is_ok());
    }

    /// A resize, by contrast, has a viewport it failed to apply, so it reports
    /// which session was missing rather than silently succeeding.
    #[test]
    fn resizing_a_session_that_is_not_running_reports_the_id() {
        let state = TerminalState::default();

        let err = resize(&state, 999, 80, 24).unwrap_err();

        assert!(err.contains("999"), "{err}");
        assert!(err.contains("not running"), "{err}");
    }

    #[test]
    fn a_fresh_state_holds_no_sessions() {
        let state = TerminalState::default();
        let terminals = state.inner.lock().unwrap();

        assert!(terminals.sessions.is_empty());
        assert_eq!(terminals.next_session_id, 1);
    }
}
