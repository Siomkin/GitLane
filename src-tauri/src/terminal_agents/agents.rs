//! The agent list config (`terminal-agents.json`): [`TerminalAgent`], its
//! persisted [`AgentEntry`] subset, shipped presets, and load/save/reset.

use super::probe::probe_available;
use super::{data_dir, write_atomically};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

pub(super) const LEGACY_CODEX_ID: &str = "codex-gpt-5-5-medium";
pub(super) const LEGACY_CODEX_NAME: &str = "codex 5.5 medium";
pub(super) const LEGACY_CODEX_COMMAND: &str =
    "codex --model gpt-5.5 -c 'model_reasoning_effort=\"medium\"'";

/// An agent as it crosses the IPC boundary: the editable fields plus the
/// PATH-probed `available` flag (computed on read, ignored on save).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAgent {
    /// Stable unique id (fixed for the four built-ins, uuid for user-added).
    pub id: String,
    /// Display name — the toolbar button text and the Settings row title.
    pub name: String,
    /// Command typed into the running shell (e.g. `claude`,
    /// `claude --model claude-opus-4-8`). May include flags and args.
    pub command: String,
    /// One-line description shown as the toolbar tooltip / Settings subtitle.
    #[serde(default)]
    pub description: String,
    /// Visibility toggle — disabled agents stay in the config but are hidden
    /// from the toolbar.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// True when the command's binary resolves on PATH. Probed on each
    /// [`load`]; never persisted.
    #[serde(default)]
    pub available: bool,
}

pub(super) fn default_enabled() -> bool {
    true
}

/// The persisted subset of [`TerminalAgent`] — everything except the computed
/// `available` flag. This is what's written to and read from the config file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentEntry {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) command: String,
    #[serde(default)]
    pub(super) description: String,
    #[serde(default = "default_enabled")]
    pub(super) enabled: bool,
}

impl From<&AgentEntry> for TerminalAgent {
    fn from(entry: &AgentEntry) -> Self {
        TerminalAgent {
            id: entry.id.clone(),
            name: entry.name.clone(),
            command: entry.command.clone(),
            description: entry.description.clone(),
            enabled: entry.enabled,
            available: probe_available(&entry.command),
        }
    }
}

impl From<&TerminalAgent> for AgentEntry {
    fn from(agent: &TerminalAgent) -> Self {
        // `available` is intentionally dropped — it's recomputed on load.
        AgentEntry {
            id: agent.id.clone(),
            name: agent.name.clone(),
            command: agent.command.clone(),
            description: agent.description.clone(),
            enabled: agent.enabled,
        }
    }
}

/// The four agents shipped out of the box, so first launch matches the old
/// hardcoded behaviour. User edits to the config file override these. The ids
/// are stable so a future "merge new defaults" migration could recognise them.
pub(super) fn defaults() -> Vec<AgentEntry> {
    vec![
        AgentEntry {
            id: "claude".into(),
            name: "claude".into(),
            command: "claude".into(),
            description: "Launch the Claude Code agent".into(),
            enabled: true,
        },
        AgentEntry {
            id: "codex".into(),
            name: "codex".into(),
            command: "codex".into(),
            description: "Launch the Codex CLI agent".into(),
            enabled: true,
        },
        AgentEntry {
            id: "claude-opus-4-8-medium".into(),
            name: "claude opus 4.8 medium".into(),
            command: "claude --model claude-opus-4-8 --effort medium".into(),
            description: "Launch Claude Code with Opus 4.8 at medium effort".into(),
            enabled: false,
        },
        AgentEntry {
            id: "codex-gpt-5-6-sol-light".into(),
            name: "codex 5.6 sol light".into(),
            command: "codex --model gpt-5.6-sol -c 'model_reasoning_effort=\"low\"'".into(),
            description: "Launch Codex with GPT-5.6 Sol at low reasoning effort".into(),
            enabled: false,
        },
    ]
}

/// Replace the untouched legacy Codex preset while preserving user edits and
/// the enabled toggle. The exact name + command match avoids rewriting a row
/// that merely retained the built-in id after being customized.
pub(super) fn migrate_builtin_presets(mut entries: Vec<AgentEntry>) -> Vec<AgentEntry> {
    // INVARIANT: `defaults()` is a non-empty literal that always includes Codex.
    let replacement = defaults().pop().expect("defaults include the Codex preset");
    for entry in &mut entries {
        if entry.id == LEGACY_CODEX_ID
            && entry.name == LEGACY_CODEX_NAME
            && entry.command == LEGACY_CODEX_COMMAND
        {
            let enabled = entry.enabled;
            *entry = replacement.clone();
            entry.enabled = enabled;
        }
    }
    entries
}

pub(super) fn config_path_in(dir: &Path) -> PathBuf {
    dir.join("terminal-agents.json")
}

/// Load the agent config, seeding defaults on first launch. Each agent's
/// `available` flag is probed via PATH. Never fails — a corrupt or missing
/// file falls back to the defaults so the toolbar always renders.
pub fn load(app: &AppHandle) -> Vec<TerminalAgent> {
    match data_dir(app) {
        Ok(dir) => load_in(&dir),
        Err(_) => seeded(defaults()),
    }
}

pub(super) fn load_in(dir: &Path) -> Vec<TerminalAgent> {
    let entries = match fs::read_to_string(config_path_in(dir)) {
        Ok(text) => serde_json::from_str::<Vec<AgentEntry>>(&text).unwrap_or_else(|_| defaults()),
        Err(_) => defaults(),
    };
    seeded(entries)
}

fn seeded(entries: Vec<AgentEntry>) -> Vec<TerminalAgent> {
    migrate_builtin_presets(entries)
        .iter()
        .map(TerminalAgent::from)
        .collect()
}

/// Persist the full agent list (replaces the config). `available` is dropped —
/// recomputed on the next [`load`]. Creates the app data dir on first write.
/// Atomic via tmp + rename so a crash mid-write can't leave a half-written file.
pub fn save(app: &AppHandle, agents: &[TerminalAgent]) -> Result<(), String> {
    save_in(&data_dir(app)?, agents)
}

pub(super) fn save_in(dir: &Path, agents: &[TerminalAgent]) -> Result<(), String> {
    let entries: Vec<AgentEntry> = agents.iter().map(AgentEntry::from).collect();
    let json = serde_json::to_string_pretty(&entries)
        .map_err(|e| format!("failed to serialize agents: {e}"))?;
    write_atomically(&config_path_in(dir), &json, "agents")
}

/// Reset the config to the shipped defaults and return them (with availability
/// probed). Convenience for the Settings "Reset to defaults" action.
pub fn reset_to_defaults(app: &AppHandle) -> Result<Vec<TerminalAgent>, String> {
    reset_to_defaults_in(&data_dir(app)?)
}

pub(super) fn reset_to_defaults_in(dir: &Path) -> Result<Vec<TerminalAgent>, String> {
    let agents: Vec<TerminalAgent> = defaults().iter().map(TerminalAgent::from).collect();
    save_in(dir, &agents)?;
    Ok(agents)
}
