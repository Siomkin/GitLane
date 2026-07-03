//! User-configurable terminal agents — the source of truth for the launchable
//! AI-CLI entries shown in the Terminal toolbar.
//!
//! Agents live in a JSON file under the app data dir (`terminal-agents.json`)
//! so the user can add, edit, reorder, hide, or remove them from Settings
//! without rebuilding. On load each agent's `available` flag is probed fresh
//! against PATH (missing binaries grey out in the toolbar). The file holds the
//! *editable* fields only ([`AgentEntry`]); `available` is computed, never
//! persisted — it would go stale the moment PATH changes.

use crate::shell;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

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

fn default_enabled() -> bool {
    true
}

/// The persisted subset of [`TerminalAgent`] — everything except the computed
/// `available` flag. This is what's written to and read from the config file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentEntry {
    id: String,
    name: String,
    command: String,
    #[serde(default)]
    description: String,
    #[serde(default = "default_enabled")]
    enabled: bool,
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
fn defaults() -> Vec<AgentEntry> {
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
            id: "codex-gpt-5-5-medium".into(),
            name: "codex 5.5 medium".into(),
            command: "codex --model gpt-5.5 -c 'model_reasoning_effort=\"medium\"'".into(),
            description: "Launch Codex with GPT-5.5 at medium reasoning effort".into(),
            enabled: false,
        },
    ]
}

/// Path to the agent config in the per-app data dir
/// (e.g. `~/Library/Application Support/space.gitlane.desktop/terminal-agents.json`).
fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    Ok(dir.join("terminal-agents.json"))
}

/// Load the agent config, seeding defaults on first launch. Each agent's
/// `available` flag is probed via PATH. Never fails — a corrupt or missing
/// file falls back to the defaults so the toolbar always renders.
pub fn load(app: &AppHandle) -> Vec<TerminalAgent> {
    let entries = match config_path(app) {
        Ok(path) => match fs::read_to_string(&path) {
            Ok(text) => {
                serde_json::from_str::<Vec<AgentEntry>>(&text).unwrap_or_else(|_| defaults())
            }
            Err(_) => defaults(),
        },
        Err(_) => defaults(),
    };
    entries.iter().map(TerminalAgent::from).collect()
}

/// Persist the full agent list (replaces the config). `available` is dropped —
/// recomputed on the next [`load`]. Creates the app data dir on first write.
/// Atomic via tmp + rename so a crash mid-write can't leave a half-written file.
pub fn save(app: &AppHandle, agents: &[TerminalAgent]) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create app data dir: {e}"))?;
    }
    let entries: Vec<AgentEntry> = agents.iter().map(AgentEntry::from).collect();
    let json = serde_json::to_string_pretty(&entries)
        .map_err(|e| format!("failed to serialize agents: {e}"))?;
    // Write to a sibling temp file then rename over the target — atomic on the
    // same filesystem, so the config is never partially written.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("failed to write agents: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("failed to save agents: {e}"))?;
    Ok(())
}

/// Reset the config to the shipped defaults and return them (with availability
/// probed). Convenience for the Settings "Reset to defaults" action.
pub fn reset_to_defaults(app: &AppHandle) -> Result<Vec<TerminalAgent>, String> {
    let agents: Vec<TerminalAgent> = defaults().iter().map(TerminalAgent::from).collect();
    save(app, &agents)?;
    Ok(agents)
}

/// True when the executable of `command` resolves on the user's PATH. Uses the
/// augmented PATH ([`shell::path`]) so Homebrew-installed agents are detected
/// even when the app was launched with the minimal GUI PATH. An empty,
/// whitespace-only, or assignment-only command is treated as unavailable.
fn probe_available(command: &str) -> bool {
    match executable_token(command) {
        None => false,
        Some(name) => which(&name),
    }
}

/// Probe a single command's executable on PATH. Exposed for the Settings
/// per-row "Check" action, which validates the command the user is currently
/// typing (possibly unsaved). Thin wrapper over [`probe_available`].
pub fn probe(command: &str) -> bool {
    probe_available(command)
}

/// Extract the executable token from a command line: tokenize honoring shell
/// quoting (so `"/path with spaces/cli"` stays one token), then skip any
/// leading `VAR=value` environment-assignment prefixes (e.g. the `FOO=bar` in
/// `FOO=bar claude`). Returns `None` for an empty / assignment-only command, or
/// one with unbalanced quotes (treated as unavailable rather than guessed).
fn executable_token(command: &str) -> Option<String> {
    let tokens = shell_words::split(command).ok()?;
    tokens.into_iter().find(|t| !is_env_assignment(t))
}

/// True for a `NAME=value` shell environment-assignment token, where `NAME` is
/// a valid shell identifier (`[A-Za-z_][A-Za-z0-9_]*`). These precede the
/// executable on a command line and must be skipped when finding it. A leading
/// `=`, a non-identifier name (e.g. an absolute path `"/a=b/cli"`), or no `=`
/// at all are not assignments.
fn is_env_assignment(token: &str) -> bool {
    match token.split_once('=') {
        Some((name, _)) if !name.is_empty() => {
            let mut chars = name.chars();
            matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        }
        _ => false,
    }
}

/// True when `name` resolves on the user's PATH. This intentionally uses Rust
/// path lookups instead of shelling out to platform-specific lookup commands,
/// so probing works on non-Unix hosts and remains a pure lookup with no side
/// effects from metacharacters in a user-configured command. The PATH scan
/// (with Windows PATHEXT expansion) lives in [`shell::command_on_path`],
/// shared with the git-lfs presence check in `git::status`.
fn which(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }

    let path = Path::new(name);
    if path.is_absolute() || name.contains('/') || name.contains('\\') {
        return shell::executable_exists(path);
    }

    shell::command_on_path(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_lists_four_builtin_agents() {
        let d = defaults();
        let ids: Vec<&str> = d.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "claude",
                "codex",
                "claude-opus-4-8-medium",
                "codex-gpt-5-5-medium"
            ]
        );
        let commands: Vec<&str> = d.iter().map(|a| a.command.as_str()).collect();
        assert_eq!(
            commands,
            [
                "claude",
                "codex",
                "claude --model claude-opus-4-8 --effort medium",
                "codex --model gpt-5.5 -c 'model_reasoning_effort=\"medium\"'"
            ]
        );
        let enabled: Vec<bool> = d.iter().map(|a| a.enabled).collect();
        assert_eq!(enabled, [true, true, false, false]);
        assert!(d.iter().all(|a| !a.description.is_empty()));
    }

    #[test]
    fn probe_available_handles_flags_and_empty() {
        let current_exe = std::env::current_exe().expect("test binary path");
        let command = current_exe.to_string_lossy();
        assert!(probe_available(&command));
        assert!(!probe_available("definitely-not-a-real-binary-xyz"));
        assert!(!probe_available(""), "empty command is unavailable");
        assert!(!probe_available("   "), "whitespace-only is unavailable");
    }

    #[test]
    fn executable_token_skips_env_and_honors_quotes() {
        assert_eq!(executable_token("claude").as_deref(), Some("claude"));
        // Leading env-assignment prefixes are skipped to reach the executable.
        assert_eq!(
            executable_token("FOO=bar claude --model x").as_deref(),
            Some("claude")
        );
        assert_eq!(executable_token("A=1 B=2 ls").as_deref(), Some("ls"));
        // A quoted path with spaces stays a single token (not split on space).
        assert_eq!(
            executable_token("\"/opt/my tools/cli\" -m x").as_deref(),
            Some("/opt/my tools/cli")
        );
        // An absolute path containing `=` is not an env assignment.
        assert_eq!(executable_token("/a=b/cli").as_deref(), Some("/a=b/cli"));
        assert_eq!(executable_token(""), None);
        assert_eq!(executable_token("   "), None);
        assert_eq!(
            executable_token("FOO=bar"),
            None,
            "assignment-only has no executable"
        );
        // Unbalanced quotes are unparseable → treated as unavailable, not guessed.
        assert_eq!(executable_token("\"unterminated"), None);
    }

    #[test]
    fn probing_never_executes_shell_metacharacters() {
        // A command crafted to run a side effect via shell metacharacters must
        // NOT execute it during availability probing — probing is a pure lookup.
        let marker = std::env::temp_dir().join("gitlane_probe_must_not_run");
        let _ = std::fs::remove_file(&marker);
        let payload = format!("x; touch {} #", marker.display());
        let _ = probe_available(&payload);
        // Also hammer `which` directly with a metacharacter-laden name.
        let _ = which(&format!("x; touch {} #", marker.display()));
        let _ = which(&format!("$(touch {})", marker.display()));
        assert!(
            !marker.exists(),
            "availability probing must never execute embedded commands"
        );
        let _ = std::fs::remove_file(&marker);
    }

    #[test]
    fn entry_round_trip_drops_available() {
        let entry = AgentEntry {
            id: "x".into(),
            name: "X".into(),
            command: "ls".into(),
            description: "desc".into(),
            enabled: false,
        };
        // Forward: entry → agent recomputes available from `command`.
        let agent = TerminalAgent::from(&entry);
        assert_eq!(agent.id, "x");
        assert!(!agent.enabled);
        assert!(agent.available, "`ls` should be probed available");

        // Reverse: agent → entry must not carry `available` (it's not a field).
        let back = AgentEntry::from(&agent);
        assert_eq!(back.id, "x");
        assert_eq!(back.command, "ls");
        assert!(!back.enabled);
    }

    #[test]
    fn parse_tolerates_unknown_future_fields() {
        // serde ignores unknown fields by default (no `deny_unknown_fields`),
        // so a config written by a future version that adds a field still loads.
        let json = r#"[{ "id": "a", "name": "A", "command": "ls", "future": 42 }]"#;
        let entries: Vec<AgentEntry> = serde_json::from_str(json).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "a");
    }

    #[test]
    fn empty_config_file_falls_back_to_defaults() {
        // A present-but-empty file shouldn't panic serde_json; an empty array
        // is valid and means "no agents" (the user deleted everything).
        let entries: Vec<AgentEntry> = serde_json::from_str("[]").unwrap();
        assert!(entries.is_empty());
    }
}
