//! In-app integrated terminal backed by a pseudo-terminal (PTY).
//!
//! One persistent PTY runs the user's login shell with cwd = the open repo;
//! xterm.js on the frontend renders the output and sends keystrokes back. The
//! launchable agent entries (opencode / kimi / claude / codex, plus anything the
//! user adds) live in [`crate::terminal_agents`] — they aren't separate
//! processes, they're typed into this shell as a command, so the user keeps
//! full interactive control and the agent inherits the repo's environment.
//!
//! Mirrors the watcher's state + events pattern: `TerminalState` is managed by
//! Tauri, the reader thread emits `pty-data` (and `pty-exit`) events, and the
//! frontend calls `pty_write` / `pty_resize` / `pty_kill`.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize, PtySystem};
use serde::Serialize;
use std::io::{Read, Write};
#[cfg(unix)]
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnResponse {
    pub session_id: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyDataEvent {
    session_id: u64,
    data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExitEvent {
    session_id: u64,
}

/// The active PTY session. `master` drives resize; `writer` sends bytes;
/// `child` is explicitly signalled on close. All behind one lock so spawn/kill
/// stay atomic.
pub struct TerminalState {
    inner: Mutex<Session>,
}

struct Session {
    session_id: u64,
    next_session_id: u64,
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Option<Box<dyn Write + Send>>,
    child: Option<Box<dyn portable_pty::Child + Send>>,
}

impl Default for TerminalState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Session {
                session_id: 0,
                next_session_id: 1,
                master: None,
                writer: None,
                child: None,
            }),
        }
    }
}

/// Kill and discard the current PTY, if any. The handles are cleared even if the
/// process ignores the signal so the UI can recover and start a fresh session.
fn kill_locked(session: &mut Session) -> Result<(), String> {
    let kill_result = session
        .child
        .take()
        .map(|mut child| {
            child
                .kill()
                .map_err(|e| format!("failed to kill pty child: {e}"))
        })
        .transpose();
    session.writer = None;
    session.master = None;
    session.session_id = 0;
    kill_result.map(|_| ())
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

/// Spawn (or replace) the PTY: open a pseudo-terminal, start the user's login
/// shell in `path`, and kick off a reader thread that streams output to the
/// frontend until the shell exits.
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

    // Replace any prior session first, then store the new handles.
    let session_id = {
        let mut session = state.inner.lock().map_err(|e| e.to_string())?;
        let _ = kill_locked(&mut session);
        let session_id = session.next_session_id;
        session.next_session_id = session.next_session_id.saturating_add(1);
        session.session_id = session_id;
        session.master = Some(pair.master);
        session.writer = Some(writer);
        session.child = Some(child);
        session_id
    };

    // Stream PTY output to the frontend until EOF (shell exit). Runs on its own
    // thread; emits raw bytes as `pty-data`, then a final `pty-exit`.
    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — shell closed the PTY.
                Ok(n) => {
                    let _ = app_for_thread.emit(
                        "pty-data",
                        PtyDataEvent {
                            session_id,
                            data: buf[..n].to_vec(),
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app_for_thread.emit("pty-exit", PtyExitEvent { session_id });
    });

    Ok(PtySpawnResponse { session_id })
}

/// Forward `data` (user keystrokes from xterm.js) to the shell's stdin.
pub fn write(state: &TerminalState, data: &[u8]) -> Result<(), String> {
    let mut session = state.inner.lock().map_err(|e| e.to_string())?;
    let writer = session
        .writer
        .as_mut()
        .ok_or_else(|| "terminal is not running".to_string())?;
    writer
        .write_all(data)
        .map_err(|e| format!("failed to write to pty: {e}"))?;
    writer
        .flush()
        .map_err(|e| format!("failed to flush pty: {e}"))?;
    Ok(())
}

/// Resize the PTY to match the xterm.js viewport (cols/rows).
pub fn resize(state: &TerminalState, cols: u16, rows: u16) -> Result<(), String> {
    let session = state.inner.lock().map_err(|e| e.to_string())?;
    let master = session
        .master
        .as_ref()
        .ok_or_else(|| "terminal is not running".to_string())?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("failed to resize pty: {e}"))
}

/// Kill the shell and clear state. Called on panel close and repo switch.
pub fn kill(state: &TerminalState) -> Result<(), String> {
    let mut session = state.inner.lock().map_err(|e| e.to_string())?;
    kill_locked(&mut session)
}
