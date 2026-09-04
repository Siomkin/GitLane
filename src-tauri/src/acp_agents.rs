//! The user's AI agents — the ones that answer in-app requests (draft a commit
//! message, describe a change) by speaking ACP to an adapter.
//!
//! Deliberately separate from [`crate::terminal_agents`], which owns a different
//! job: commands typed into a terminal tab. The two used to be one record with
//! two command fields, and it never stopped being confusing — an entry could be
//! valid with either command, half the fields were meaningless on any given
//! row, and renaming an agent for one purpose renamed it for the other. They
//! share nothing but the word "agent".
//!
//! Config lives in `acp-agents.json` beside the terminal list. An install that
//! predates the split is migrated once, from whatever terminal agents carried an
//! `acpCommand`.

use crate::acp;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// An AI agent as it crosses the IPC boundary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgent {
    /// Stable unique id (adapter id for the seeded entries, uuid for the rest).
    pub id: String,
    /// Display name — what the Draft / Describe menus list.
    pub name: String,
    /// The ACP adapter command, e.g. `cursor-agent acp`.
    pub command: String,
    /// Adapter-defined model id this agent pins its session to (`""` = the
    /// adapter's default). Applied via `session/set_model` /
    /// `session/set_config_option`.
    #[serde(default)]
    pub model: String,
    /// Other session config pins keyed by option id (`effort`, `fast`, …).
    /// Empty values mean "adapter default" and are not sent.
    #[serde(default)]
    pub config: BTreeMap<String, String>,
    #[serde(default)]
    pub description: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// True when the adapter's executable resolves on PATH. Computed on every
    /// read — it would go stale the moment PATH changes — and ignored on save.
    #[serde(default)]
    pub available: bool,
}

fn yes() -> bool {
    true
}

/// The persisted subset: everything but the computed `available` flag.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    name: String,
    command: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    config: BTreeMap<String, String>,
    #[serde(default)]
    description: String,
    #[serde(default = "yes")]
    enabled: bool,
}

impl From<&Entry> for AcpAgent {
    fn from(entry: &Entry) -> Self {
        AcpAgent {
            id: entry.id.clone(),
            name: entry.name.clone(),
            command: entry.command.clone(),
            model: entry.model.clone(),
            config: entry.config.clone(),
            description: entry.description.clone(),
            enabled: entry.enabled,
            available: crate::terminal_agents::probe(&entry.command),
        }
    }
}

impl From<&AcpAgent> for Entry {
    fn from(agent: &AcpAgent) -> Self {
        Entry {
            id: agent.id.clone(),
            name: agent.name.clone(),
            command: agent.command.clone(),
            model: agent.model.clone(),
            config: agent.config.clone(),
            description: agent.description.clone(),
            enabled: agent.enabled,
        }
    }
}

/// Where the config lives. Split from the readers and writers below so they
/// take a plain directory: `AppHandle::path()` resolves to the real
/// `~/Library/Application Support` even under `tauri::test`'s mock runtime, so
/// a test that went through the handle would read and write the developer's
/// own config. Same idiom as [`entries_from_terminal_rows`] — the half that
/// does the work is kept free of `AppHandle` so tests can drive it.
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))
}

fn config_path_in(dir: &Path) -> PathBuf {
    dir.join("acp-agents.json")
}

/// The agents seeded on a fresh install: one per adapter whose CLI is present,
/// so a user who already has Claude or Cursor installed finds them ready rather
/// than an empty list. An adapter that isn't installed would only be a row that
/// fails on click — the Settings catalogue is where those are discovered.
fn defaults() -> Vec<Entry> {
    acp::catalog()
        .into_iter()
        .filter(|adapter| adapter.available)
        .map(|adapter| Entry {
            id: adapter.id,
            name: adapter.name,
            command: adapter.command,
            model: String::new(),
            config: BTreeMap::new(),
            description: String::new(),
            enabled: true,
        })
        .collect()
}

/// Carry ACP-capable entries over from the pre-split `terminal-agents.json`.
///
/// Read as raw JSON on purpose: [`crate::terminal_agents`] no longer has these
/// fields, and reviving them there just to migrate would undo the split. Returns
/// `None` when there is nothing to carry, so the caller falls back to defaults.
fn migrate_from_terminal_agents_in(dir: &Path) -> Option<Vec<Entry>> {
    let text = fs::read_to_string(dir.join("terminal-agents.json")).ok()?;
    let rows: Vec<serde_json::Value> = serde_json::from_str(&text).ok()?;
    let migrated = entries_from_terminal_rows(&rows);
    (!migrated.is_empty()).then_some(migrated)
}

/// Pure half of the terminal→AI-agent migration — kept free of `AppHandle` so
/// unit tests can exercise the same mapper production uses.
fn entries_from_terminal_rows(rows: &[serde_json::Value]) -> Vec<Entry> {
    rows.iter()
        .filter_map(|row| {
            let command = row.get("acpCommand")?.as_str()?.trim();
            if command.is_empty() {
                return None;
            }
            Some(Entry {
                id: row.get("id")?.as_str()?.to_owned(),
                name: row.get("name")?.as_str().unwrap_or("Agent").to_owned(),
                command: command.to_owned(),
                model: row
                    .get("acpModel")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_owned(),
                config: BTreeMap::new(),
                description: row
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_owned(),
                enabled: row.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
            })
        })
        .collect()
}

/// Load the AI agents, seeding or migrating on first run.
///
/// A file that exists but does not parse is *not* treated as a first run: the
/// old behaviour re-seeded and saved over it, destroying a hand-edited config
/// on the first mistyped comma. It returns the seeds for this session and
/// leaves the file alone, so the user can fix it.
pub fn load(app: &AppHandle) -> Vec<AcpAgent> {
    match data_dir(app) {
        Ok(dir) => load_in(&dir),
        // Nothing to read and nowhere to save: seed for this session only.
        Err(_) => defaults().iter().map(AcpAgent::from).collect(),
    }
}

fn load_in(dir: &Path) -> Vec<AcpAgent> {
    let text = Some(config_path_in(dir)).and_then(|path| match fs::read_to_string(path) {
        Ok(text) => Some(text),
        // Any other read error (permissions, a directory in the way) is also
        // "not first run" — but there is nothing to parse, so it seeds without
        // saving, same as a corrupt file.
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                crate::log::warn!("acp-agents.json could not be read: {error}");
            }
            None
        }
    });
    let entries = match text {
        Some(text) => match serde_json::from_str::<Vec<Entry>>(&text) {
            Ok(entries) => entries,
            Err(error) => {
                crate::log::warn!(
                    "acp-agents.json is not valid JSON ({error}); leaving it untouched"
                );
                defaults()
            }
        },
        // First run after the split (or ever): inherit, else seed.
        None => {
            let entries = migrate_from_terminal_agents_in(dir).unwrap_or_else(defaults);
            // Persist immediately so the migration happens exactly once; a
            // failure here is survivable (it simply runs again next launch).
            let _ = save_entries_in(dir, &entries);
            entries
        }
    };
    entries.iter().map(AcpAgent::from).collect()
}

fn save_entries_in(dir: &Path, entries: &[Entry]) -> Result<(), String> {
    let path = config_path_in(dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create app data dir: {e}"))?;
    }
    let json =
        serde_json::to_string_pretty(entries).map_err(|e| format!("failed to serialize: {e}"))?;
    // tmp + rename: atomic on one filesystem, so a crash mid-write cannot leave
    // a half-written config behind.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("failed to write AI agents: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("failed to save AI agents: {e}"))?;
    Ok(())
}

/// Persist the full list (replaces the config). `available` is dropped — it is
/// recomputed on the next [`load`].
pub fn save(app: &AppHandle, agents: &[AcpAgent]) -> Result<(), String> {
    save_in(&data_dir(app)?, agents)
}

fn save_in(dir: &Path, agents: &[AcpAgent]) -> Result<(), String> {
    let entries: Vec<Entry> = agents.iter().map(Entry::from).collect();
    save_entries_in(dir, &entries)
}

/// Reset to the seeded list and return it.
pub fn reset(app: &AppHandle) -> Result<Vec<AcpAgent>, String> {
    reset_in(&data_dir(app)?)
}

fn reset_in(dir: &Path) -> Result<Vec<AcpAgent>, String> {
    let entries = defaults();
    save_entries_in(dir, &entries)?;
    Ok(entries.iter().map(AcpAgent::from).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(json: serde_json::Value) -> Vec<serde_json::Value> {
        vec![json]
    }

    /// The migration's pure half, exercised without an AppHandle.
    fn migrate(rows: &[serde_json::Value]) -> Vec<Entry> {
        entries_from_terminal_rows(rows)
    }

    #[test]
    fn migration_takes_only_the_acp_capable_terminal_agents() {
        let rows = vec![
            serde_json::json!({
                "id": "claude", "name": "claude", "command": "claude",
                "acpCommand": "npx -y @agentclientprotocol/claude-agent-acp",
                "acpModel": "", "enabled": true
            }),
            // Terminal-only: it has no way to answer, so it stays behind.
            serde_json::json!({ "id": "tui", "name": "tui", "command": "tui", "acpCommand": "" }),
            serde_json::json!({ "id": "bare", "name": "bare", "command": "bare" }),
            serde_json::json!({
                "id": "sol", "name": "codex 5.6 sol light", "command": "codex --model x",
                "acpCommand": "npx -y @agentclientprotocol/codex-acp",
                "acpModel": "gpt-5.6-sol[low]", "enabled": false
            }),
        ];

        let migrated = migrate(&rows);

        assert_eq!(migrated.len(), 2);
        assert_eq!(migrated[0].id, "claude");
        // The model pin travels — it is the whole reason that agent existed.
        assert_eq!(migrated[1].name, "codex 5.6 sol light");
        assert_eq!(migrated[1].model, "gpt-5.6-sol[low]");
        assert!(!migrated[1].enabled, "the enabled toggle is preserved");
        // The terminal command is deliberately not carried: it belongs to the
        // terminal agent of the same name, which keeps it.
    }

    #[test]
    fn a_config_with_no_acp_agents_migrates_to_nothing() {
        let rows = row(serde_json::json!({ "id": "a", "name": "a", "command": "a" }));
        assert!(migrate(&rows).is_empty());
    }

    #[test]
    fn entries_round_trip_and_drop_the_computed_flag() {
        let agent = AcpAgent {
            id: "cursor".into(),
            name: "Cursor".into(),
            command: "cursor-agent acp".into(),
            model: "default[]".into(),
            config: BTreeMap::from([("effort".into(), "high".into())]),
            description: "desc".into(),
            enabled: false,
            available: true,
        };
        let entry = Entry::from(&agent);
        assert_eq!(entry.model, "default[]");
        assert_eq!(entry.config.get("effort").map(String::as_str), Some("high"));
        assert!(!entry.enabled);

        let json = serde_json::to_string(&entry).unwrap();
        assert!(!json.contains("acpCommand"), "fields are un-prefixed");
        assert!(
            !json.contains("available"),
            "the computed flag is not persisted"
        );
    }

    #[test]
    fn a_pre_split_entry_without_the_optional_fields_still_parses() {
        // `model`, `description` and `enabled` all default, so a hand-written or
        // future-truncated config loads rather than resetting the user's list.
        let entry: Entry =
            serde_json::from_str(r#"{"id":"a","name":"A","command":"a acp"}"#).unwrap();
        assert_eq!(entry.model, "");
        assert!(entry.config.is_empty());
        assert!(entry.enabled);
    }

    /// A throwaway data dir that cleans itself up on drop — the same
    /// dependency-free shape the git write tests use, so no `tempfile` dev-dep.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir =
                std::env::temp_dir().join(format!("gitlane-acp-{tag}-{}-{n}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn agent(id: &str) -> AcpAgent {
        AcpAgent {
            id: id.to_string(),
            name: id.to_string(),
            command: format!("{id} acp"),
            model: "m".to_string(),
            config: BTreeMap::new(),
            description: String::new(),
            enabled: true,
            available: true,
        }
    }

    #[test]
    fn save_then_load_round_trips_the_list() {
        let dir = TempDir::new("round-trip");

        save_in(&dir.0, &[agent("claude"), agent("codex")]).unwrap();
        let loaded = load_in(&dir.0);

        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "claude");
        assert_eq!(loaded[1].command, "codex acp");
        assert_eq!(loaded[0].model, "m");
    }

    #[test]
    fn save_creates_the_data_dir_when_it_does_not_exist_yet() {
        let dir = TempDir::new("missing");
        let nested = dir.0.join("not-created-yet");

        save_in(&nested, &[agent("claude")]).unwrap();

        assert!(
            config_path_in(&nested).exists(),
            "first run creates the dir"
        );
    }

    #[test]
    fn reset_replaces_a_customised_list_with_the_seeds() {
        let dir = TempDir::new("reset");
        save_in(&dir.0, &[agent("hand-written")]).unwrap();

        let after = reset_in(&dir.0).unwrap();

        // `defaults()` probes which adapter CLIs are installed, so the seeded
        // list is environment-dependent — what matters is that the user's own
        // entry is gone and the file now matches what reset returned.
        assert!(after.iter().all(|a| a.id != "hand-written"));
        assert_eq!(load_in(&dir.0).len(), after.len());
    }

    #[test]
    fn malformed_json_seeds_the_session_and_leaves_the_file_untouched() {
        // Re-seeding and saving over a mistyped comma used to destroy a
        // hand-edited config. The file must survive so the user can fix it.
        let dir = TempDir::new("malformed");
        let path = config_path_in(&dir.0);
        let broken = r#"[{"id":"a","name":"A","command":"a",}]"#;
        fs::write(&path, broken).unwrap();

        let loaded = load_in(&dir.0);

        assert_eq!(fs::read_to_string(&path).unwrap(), broken);
        // Seeded for this session rather than carrying the unreadable entry.
        assert!(loaded.iter().all(|a| a.id != "a"));
    }

    #[test]
    fn a_first_run_migrates_the_acp_capable_terminal_agents_once() {
        let dir = TempDir::new("migrate");
        fs::write(
            dir.0.join("terminal-agents.json"),
            serde_json::to_string(&serde_json::json!([
                { "id": "claude", "name": "claude", "command": "claude",
                  "acpCommand": "claude-acp", "acpModel": "opus", "enabled": true },
                { "id": "tui", "name": "tui", "command": "tui" }
            ]))
            .unwrap(),
        )
        .unwrap();

        let loaded = load_in(&dir.0);

        assert_eq!(loaded.len(), 1, "only the ACP-capable row carries over");
        assert_eq!(loaded[0].command, "claude-acp");
        // Persisted immediately, so the next launch reads the new file instead
        // of migrating a second time.
        assert!(config_path_in(&dir.0).exists());
    }
}
