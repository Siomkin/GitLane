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
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnResponse {
    pub session_id: u64,
}

/// One live PTY session. `master` drives resize; `input` queues bytes for the
/// session's writer thread (see [`spawn_writer`]); `child` is explicitly
/// signalled on close. Dropping the session drops `input`, which ends the
/// writer thread.
struct Session {
    master: Box<dyn MasterPty + Send>,
    input: Sender<Vec<u8>>,
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

/// Color-related env for an interactive PTY. `TERM`/`COLORTERM` advertise a
/// capable terminal; `NO_COLOR` is stripped so a parent CI/editor launch
/// cannot silently disable ANSI in bun/vite/git inside the drawer.
fn apply_interactive_color_env(cmd: &mut CommandBuilder) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env_remove("NO_COLOR");
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
    apply_interactive_color_env(&mut cmd);
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
                input: spawn_writer(writer),
                child,
            },
        );
        session_id
    };

    // Stream PTY output to the frontend until EOF (shell exit). Runs on its own
    // thread; emits raw bytes as `pty-data`, then a final `pty-exit`.
    let app_for_thread = app.clone();
    let inner_for_thread = Arc::clone(&state.inner);
    std::thread::spawn(move || {
        stream_until_exit(reader, &inner_for_thread, session_id, |data| {
            crate::events::emit(
                &app_for_thread,
                crate::events::PTY_DATA,
                crate::events::PtyDataEvent {
                    session_id,
                    data: data.to_vec(),
                },
            );
        });
        crate::events::emit(
            &app_for_thread,
            crate::events::PTY_EXIT,
            crate::events::PtyExitEvent { session_id },
        );
    });

    Ok(PtySpawnResponse { session_id })
}

/// Start the session's single writer thread and return its input queue.
///
/// A PTY master write blocks once the slave's input queue is full (a program not
/// reading stdin), so the write happens here, never on the UI thread or under
/// the shared terminal lock. One consumer per session keeps keystrokes in the
/// order they were queued. The thread ends when every `Sender` is dropped (the
/// session was killed or its shell exited) or when a write fails — killing the
/// child closes the slave, so a write blocked at that moment errors out too.
fn spawn_writer(mut writer: Box<dyn Write + Send>) -> Sender<Vec<u8>> {
    let (input, queue) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for data in queue {
            if writer
                .write_all(&data)
                .and_then(|()| writer.flush())
                .is_err()
            {
                break;
            }
        }
    });
    input
}

/// Queue `data` (user keystrokes from xterm.js) for session `session_id`'s
/// stdin. Only enqueues: the map lock is held for a lookup and a channel send,
/// and the blocking PTY write runs on the session's writer thread.
pub fn write(state: &TerminalState, session_id: u64, data: Vec<u8>) -> Result<(), String> {
    let terminals = state.inner.lock().map_err(|e| e.to_string())?;
    terminals
        .sessions
        .get(&session_id)
        .and_then(|session| session.input.send(data).ok())
        .ok_or_else(|| format!("terminal {session_id} is not running"))
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

/// Hand session `session_id`'s output to `on_data` until its shell closes the
/// PTY, then drop the session's map entry and reap the shell. A shell that
/// `exit`s on its own is never [`kill`]ed, so without the `wait` here it stays
/// a zombie until the app quits. The PTY is at EOF by then, so the shell is
/// exiting and the `wait` only collects its status.
fn stream_until_exit(
    mut reader: Box<dyn Read + Send>,
    inner: &Mutex<Terminals>,
    session_id: u64,
    mut on_data: impl FnMut(&[u8]),
) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break, // EOF — shell closed the PTY.
            Ok(n) => on_data(&buf[..n]),
            Err(_) => break,
        }
    }
    let session = inner
        .lock()
        .ok()
        .and_then(|mut terminals| terminals.sessions.remove(&session_id));
    if let Some(mut session) = session {
        let _ = session.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Records each write the PTY would receive, in arrival order.
    struct Recorder(mpsc::Sender<Vec<u8>>);

    impl Write for Recorder {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.write_all(buf)?;
            Ok(buf.len())
        }
        fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
            self.0
                .send(buf.to_vec())
                .map_err(|_| std::io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn queued_writes_reach_the_pty_in_the_order_typed() {
        let (seen, received) = mpsc::channel();
        let input = spawn_writer(Box::new(Recorder(seen)));
        let sent: Vec<Vec<u8>> = (0..500).map(|i| i.to_string().into_bytes()).collect();
        for data in &sent {
            input.send(data.clone()).unwrap();
        }
        // Dropping the last sender ends the writer thread, which drops the
        // recorder and closes `received` once everything has been written.
        drop(input);
        let got: Vec<Vec<u8>> = received.iter().collect();
        assert_eq!(got, sent);
    }

    #[test]
    fn writing_to_a_session_that_is_not_running_reports_the_id() {
        let state = TerminalState::default();
        let err = write(&state, 42, b"x".to_vec()).unwrap_err();
        assert!(err.contains("42"), "{err}");
    }

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

    /// A shell that exits on its own is reaped, not left a zombie.
    #[cfg(unix)]
    #[test]
    fn a_shell_that_exits_on_its_own_is_reaped() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "exit 0"]);
        let child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let pid = child.process_id().unwrap();
        let reader = pair.master.try_clone_reader().unwrap();
        let writer = pair.master.take_writer().unwrap();
        let state = TerminalState::default();
        state.inner.lock().unwrap().sessions.insert(
            7,
            Session {
                master: pair.master,
                input: spawn_writer(writer),
                child,
            },
        );

        stream_until_exit(reader, &state.inner, 7, |_| {});

        assert!(state.inner.lock().unwrap().sessions.is_empty());
        // `ps` lists a zombie (`Z`) until its parent waits; a reaped pid is gone.
        let ps = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&ps.stdout).trim(), "");
    }

    #[test]
    fn a_fresh_state_holds_no_sessions() {
        let state = TerminalState::default();
        let terminals = state.inner.lock().unwrap();

        assert!(terminals.sessions.is_empty());
        assert_eq!(terminals.next_session_id, 1);
    }

    #[test]
    fn interactive_pty_requests_color_and_strips_no_color() {
        let mut cmd = CommandBuilder::new("sh");
        cmd.env("NO_COLOR", "1");
        apply_interactive_color_env(&mut cmd);

        assert_eq!(
            cmd.get_env("TERM").unwrap().to_str(),
            Some("xterm-256color")
        );
        assert_eq!(
            cmd.get_env("COLORTERM").unwrap().to_str(),
            Some("truecolor")
        );
        assert_eq!(cmd.get_env("NO_COLOR"), None);
    }
}
