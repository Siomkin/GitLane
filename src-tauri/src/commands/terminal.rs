//! The in-app terminal: PTY sessions, terminal agents, and agent commit-draft hand-off.

use super::blocking;
use crate::acp_agents::AcpAgent;
use crate::terminal::TerminalState;
use crate::terminal_agents::{CommitAgentMessages, TerminalAgent};
use crate::{acp, acp_agents, terminal, terminal_agents};
use std::path::PathBuf;

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

/// The user's AI agents — the ones that answer Draft / Describe over ACP.
/// Availability is probed via PATH per read, so this runs off the main thread.
#[tauri::command]
pub async fn acp_agents_get(app: tauri::AppHandle) -> Result<Vec<AcpAgent>, String> {
    blocking(move || Ok(acp_agents::load(&app))).await
}

/// Persist the full AI-agent list (replaces the config). File I/O only.
#[tauri::command]
pub fn acp_agents_set(app: tauri::AppHandle, agents: Vec<AcpAgent>) -> Result<(), String> {
    acp_agents::save(&app, &agents)
}

/// Reset the AI-agent list to the seeded defaults and return it.
#[tauri::command]
pub async fn acp_agents_reset(app: tauri::AppHandle) -> Result<Vec<AcpAgent>, String> {
    blocking(move || acp_agents::reset(&app)).await
}

/// The ACP adapters GitLane has been verified against, for the Settings picker.
/// Probes PATH for each entry (same work as `terminal_agents_get`), so it stays
/// off the main thread.
#[tauri::command]
pub async fn acp_adapters() -> Result<Vec<acp::AcpAdapter>, String> {
    blocking(|| Ok(acp::catalog())).await
}

/// Ask an ACP adapter what it is and which models it offers. Backs the Settings
/// status row and model picker: a successful probe means the adapter is
/// installed, launchable, and signed in; a failure explains which of those
/// failed. Spawns a subprocess, so it stays off the main thread.
#[tauri::command]
pub async fn acp_probe(agent_command: String, path: String) -> Result<acp::AcpProbe, String> {
    blocking(move || acp::probe(&agent_command, &PathBuf::from(&path))).await
}

/// Ask an ACP-capable agent one question about the repo at `path` and return
/// its answer — the structured alternative to the terminal + mailbox handoff.
/// `agent_command` is the agent's ACP launch command, `model` its optional
/// pinned model id, and `config` other session config pins (effort, fast, …).
/// `run_id` tags every `acp-progress` tick so concurrent Draft/Describe banners
/// only show their own turn. Spawns a subprocess and blocks on its stdio, so it
/// must stay off the main thread.
#[tauri::command]
pub async fn acp_prompt(
    app: tauri::AppHandle,
    agent_command: String,
    path: String,
    model: String,
    config: std::collections::BTreeMap<String, String>,
    prompt: String,
    run_id: String,
) -> Result<String, String> {
    use tauri::Emitter;

    blocking(move || {
        // A dropped progress tick must never fail the turn itself.
        let app = app.clone();
        let run_id = run_id.clone();
        let progress: std::sync::Arc<dyn Fn(&str) + Send + Sync> =
            std::sync::Arc::new(move |message: &str| {
                let _ = app.emit(
                    "acp-progress",
                    acp::AcpProgress {
                        run_id: run_id.clone(),
                        message: message.to_owned(),
                    },
                );
            });
        acp::prompt(
            &agent_command,
            &PathBuf::from(&path),
            &model,
            &config,
            &prompt,
            progress,
        )
    })
    .await
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
