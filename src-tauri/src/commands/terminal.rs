//! The in-app terminal: PTY sessions, terminal agents, and agent commit-draft hand-off.

use super::blocking;
use crate::terminal::TerminalState;
use crate::terminal_agents::{CommitAgentMessages, TerminalAgent};
use crate::{terminal, terminal_agents};

/// All configured terminal agents (enabled + disabled), each with its command's
/// availability probed via PATH. Probing can touch the filesystem for each
/// agent, so it runs off the main thread. The config file is the source of
/// truth; the frontend edits it through [`terminal_agents_set`].
#[tauri::command]
pub async fn terminal_agents_get(app: tauri::AppHandle) -> Result<Vec<TerminalAgent>, String> {
    blocking(move || Ok(terminal_agents::load(&app))).await
}

/// Persist the full agent list (replaces the config). `available` is ignored —
/// it's recomputed on the next [`terminal_agents_get`]. File I/O only, no
/// subprocess, so a plain sync command is fine (see read/write split rules).
#[tauri::command]
pub fn terminal_agents_set(
    app: tauri::AppHandle,
    agents: Vec<TerminalAgent>,
) -> Result<(), String> {
    terminal_agents::save(&app, &agents)
}

/// Read the user-editable instructions used by Draft / Improve and Commit with
/// agent. Fixed safety and delivery suffixes are assembled in the frontend.
#[tauri::command]
pub fn commit_agent_messages_get(app: tauri::AppHandle) -> CommitAgentMessages {
    terminal_agents::load_messages(&app)
}

#[tauri::command]
pub fn commit_agent_messages_set(
    app: tauri::AppHandle,
    messages: CommitAgentMessages,
) -> Result<(), String> {
    terminal_agents::save_messages(&app, &messages)
}

#[tauri::command]
pub fn commit_agent_messages_reset(app: tauri::AppHandle) -> Result<CommitAgentMessages, String> {
    terminal_agents::reset_messages_to_defaults(&app)
}

/// Reset the agent config to the shipped defaults and return them. Used by the
/// Settings "Reset to defaults" action.
#[tauri::command]
pub async fn terminal_agents_reset(app: tauri::AppHandle) -> Result<Vec<TerminalAgent>, String> {
    // Returns probed agents, so it touches PATH like terminal_agents_get — keep
    // the same off-the-main-thread discipline.
    blocking(move || terminal_agents::reset_to_defaults(&app)).await
}

/// Probe whether a single agent command's executable resolves on PATH. Backs
/// the Settings "Check" button, which validates a command (possibly unsaved)
/// live. It can touch the filesystem, so it runs off the main thread.
#[tauri::command]
pub async fn terminal_agent_probe(command: String) -> Result<bool, String> {
    blocking(move || Ok(terminal_agents::probe(&command))).await
}

/// Poll the unique Git-metadata handoff file used when an interactive agent
/// drafts a commit message. Reading/removing the tiny file is intentionally a
/// sync command; the expensive work remains in the agent's terminal session.
#[tauri::command]
pub fn take_agent_commit_draft(path: String, token: String) -> Result<Option<String>, String> {
    terminal_agents::take_commit_draft(&path, &token)
}

/// Poll the unique Git-metadata handoff file used when an interactive agent
/// summarizes the current working changes.
#[tauri::command]
pub fn take_agent_change_summary(path: String, token: String) -> Result<Option<String>, String> {
    terminal_agents::take_change_summary(&path, &token)
}

/// Spawn a new in-app terminal PTY running the user's login shell in `path` and
/// return its `sessionId`; existing sessions keep running. Output streams back as
/// `pty-data` events tagged with that id; exit fires `pty-exit`.
#[tauri::command]
pub async fn pty_spawn(
    app: tauri::AppHandle,
    state: tauri::State<'_, TerminalState>,
    path: String,
    cols: u16,
    rows: u16,
) -> Result<terminal::PtySpawnResponse, String> {
    // Opening a PTY and spawning the login shell can block on OS/process setup.
    // Clone the Arc-backed state out of Tauri's non-'static State wrapper so
    // the established blocking pool owns the whole operation.
    let state = state.inner().clone();
    blocking(move || terminal::spawn(&state, &app, &path, cols, rows)).await
}

/// Forward user keystrokes (from xterm.js) to session `session_id`'s stdin.
#[tauri::command]
pub fn pty_write(
    state: tauri::State<'_, TerminalState>,
    session_id: u64,
    data: Vec<u8>,
) -> Result<(), String> {
    terminal::write(&state, session_id, &data)
}

/// Resize session `session_id`'s PTY to match the xterm.js viewport.
#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, TerminalState>,
    session_id: u64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    terminal::resize(&state, session_id, cols, rows)
}

/// Kill one terminal tab's shell and drop its session.
#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, TerminalState>, session_id: u64) -> Result<(), String> {
    terminal::kill(&state, session_id)
}
