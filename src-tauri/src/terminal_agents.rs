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
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};

const DRAFT_PREFIX: &str = "gitlane-commit-draft-";
const MAX_DRAFT_BYTES: u64 = 8 * 1024;
const SUMMARY_PREFIX: &str = "gitlane-change-summary-";
// A safety guard against an agent accidentally delivering a huge artifact,
// not a desired description-length limit. Normal detailed explanations should
// fit comfortably beneath it.
const MAX_SUMMARY_BYTES: u64 = 32 * 1024;
/// Every one-shot mailbox filename prefix, swept together so a stale delivery
/// from either agent flow is cleared during any active poll.
const MAILBOX_PREFIXES: [&str; 2] = [DRAFT_PREFIX, SUMMARY_PREFIX];
/// A mailbox older than this belongs to a request that already gave up (the
/// draft poll after two minutes, the description poll after five), so deleting
/// it cannot race an in-flight delivery.
const MAILBOX_TTL: Duration = Duration::from_secs(10 * 60);
const LEGACY_CODEX_ID: &str = "codex-gpt-5-5-medium";
const LEGACY_CODEX_NAME: &str = "codex 5.5 medium";
const LEGACY_CODEX_COMMAND: &str = "codex --model gpt-5.5 -c 'model_reasoning_effort=\"medium\"'";

pub const DEFAULT_DRAFT_INSTRUCTION: &str =
    "Review the staged changes and draft a concise conventional commit message.";
pub const DEFAULT_COMMIT_INSTRUCTION: &str =
    "Review the staged changes, write a concise conventional-commit message, and commit them.";
pub const DEFAULT_DESCRIPTION_INSTRUCTION: &str =
    "Write a clear plain-text explanation of what the changes do and why they matter. Cover the main behavior, important implementation details, and notable effects or risks. Use as much detail as needed to make the changes understandable, while avoiding repetition or a file-by-file inventory.";

fn default_description_instruction() -> String {
    DEFAULT_DESCRIPTION_INSTRUCTION.into()
}

/// User-editable instructions for terminal-agent actions. GitLane keeps
/// its safety, excluded-path, and one-shot delivery suffixes outside this
/// persisted text so users cannot accidentally remove the handoff contract.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitAgentMessages {
    pub draft_instruction: String,
    pub commit_instruction: String,
    #[serde(default = "default_description_instruction")]
    pub description_instruction: String,
}

impl Default for CommitAgentMessages {
    fn default() -> Self {
        Self {
            draft_instruction: DEFAULT_DRAFT_INSTRUCTION.into(),
            commit_instruction: DEFAULT_COMMIT_INSTRUCTION.into(),
            description_instruction: DEFAULT_DESCRIPTION_INSTRUCTION.into(),
        }
    }
}

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
fn migrate_builtin_presets(mut entries: Vec<AgentEntry>) -> Vec<AgentEntry> {
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

/// Path to the agent config in the per-app data dir
/// (e.g. `~/Library/Application Support/space.gitlane.desktop/terminal-agents.json`).
fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    Ok(dir.join("terminal-agents.json"))
}

fn messages_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    Ok(dir.join("commit-agent-messages.json"))
}

/// Load the saved agent instructions. A missing or corrupt config uses the
/// shipped defaults so all agent actions remain usable.
pub fn load_messages(app: &AppHandle) -> CommitAgentMessages {
    messages_config_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<CommitAgentMessages>(&text).ok())
        .filter(valid_messages)
        .unwrap_or_default()
}

/// Persist all instructions atomically. Blank instructions are rejected at
/// the IPC boundary even though the Settings UI also validates them.
pub fn save_messages(app: &AppHandle, messages: &CommitAgentMessages) -> Result<(), String> {
    if !valid_messages(messages) {
        return Err("Description, draft, and commit instructions are required.".into());
    }
    let path = messages_config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create app data dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(messages)
        .map_err(|e| format!("failed to serialize commit agent messages: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("failed to write commit agent messages: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("failed to save commit agent messages: {e}"))?;
    Ok(())
}

pub fn reset_messages_to_defaults(app: &AppHandle) -> Result<CommitAgentMessages, String> {
    let messages = CommitAgentMessages::default();
    save_messages(app, &messages)?;
    Ok(messages)
}

fn valid_messages(messages: &CommitAgentMessages) -> bool {
    !messages.draft_instruction.trim().is_empty()
        && !messages.commit_instruction.trim().is_empty()
        && !messages.description_instruction.trim().is_empty()
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
    migrate_builtin_presets(entries)
        .iter()
        .map(TerminalAgent::from)
        .collect()
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

/// The distinguishing shape of a one-shot agent mailbox: its filename prefix,
/// size guard, and the human nouns used in its error messages. Lets the two
/// flows share one consume path without their user-facing strings drifting.
struct MailboxKind {
    prefix: &'static str,
    max_bytes: u64,
    invalid_token: &'static str,
    too_large: &'static str,
    noun: &'static str,
}

const DRAFT_MAILBOX: MailboxKind = MailboxKind {
    prefix: DRAFT_PREFIX,
    max_bytes: MAX_DRAFT_BYTES,
    invalid_token: "Invalid agent draft token.",
    too_large: "The agent draft is unexpectedly large.",
    noun: "agent draft",
};

const SUMMARY_MAILBOX: MailboxKind = MailboxKind {
    prefix: SUMMARY_PREFIX,
    max_bytes: MAX_SUMMARY_BYTES,
    invalid_token: "Invalid change-summary token.",
    too_large: "The agent change summary is unexpectedly large.",
    noun: "change summary",
};

/// Remove one-shot mailboxes that no request will ever consume: an empty
/// delivery, or one left behind by a request that already timed out (older than
/// [`MAILBOX_TTL`]). Best-effort — failures never surface, and the caller's own
/// mailbox is always younger than the TTL, so it is never swept out from under
/// an in-flight poll. The `.tmp` sibling an agent renames from also carries the
/// prefix; it is only removed once abandoned (past the TTL), never mid-write.
fn sweep_mailboxes(git_dir: &Path) {
    let Ok(entries) = fs::read_dir(git_dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if !MAILBOX_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
        {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let abandoned = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > MAILBOX_TTL);
        let empty_final = metadata.len() == 0 && !name.ends_with(".tmp");
        if empty_final || abandoned {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Consume a one-shot mailbox written by an interactive terminal agent. The
/// token is generated by the frontend and restricted to a filename-safe
/// alphabet. Resolving through libgit2's git directory keeps linked worktrees
/// isolated from the main checkout. Each call first sweeps stale mailboxes so a
/// late delivery from an already-timed-out request cannot accumulate.
fn take_mailbox(path: &str, token: &str, kind: &MailboxKind) -> Result<Option<String>, String> {
    if token.is_empty()
        || token.len() > 64
        || !token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(kind.invalid_token.into());
    }
    let repo = git2::Repository::open(path).map_err(|error| error.to_string())?;
    let git_dir = repo.path();
    sweep_mailboxes(git_dir);
    let mailbox_path = git_dir.join(format!("{}{token}", kind.prefix));
    let metadata = match fs::metadata(&mailbox_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not inspect the {}: {error}", kind.noun)),
    };
    if metadata.len() > kind.max_bytes {
        let _ = fs::remove_file(&mailbox_path);
        return Err(kind.too_large.into());
    }
    let contents = fs::read_to_string(&mailbox_path)
        .map_err(|error| format!("Could not read the {}: {error}", kind.noun))?;
    if contents.trim().is_empty() {
        let _ = fs::remove_file(&mailbox_path);
        return Ok(None);
    }
    fs::remove_file(&mailbox_path)
        .map_err(|error| format!("Could not consume the {}: {error}", kind.noun))?;
    Ok(Some(contents.trim().to_owned()))
}

/// Consume a commit-message draft written by an interactive terminal agent.
pub fn take_commit_draft(path: &str, token: &str) -> Result<Option<String>, String> {
    take_mailbox(path, token, &DRAFT_MAILBOX)
}

/// Consume a change description written by a configured interactive agent.
pub fn take_change_summary(path: &str, token: &str) -> Result<Option<String>, String> {
    take_mailbox(path, token, &SUMMARY_MAILBOX)
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
    fn commit_agent_message_defaults_are_valid_and_use_camel_case() {
        let messages = CommitAgentMessages::default();
        assert!(valid_messages(&messages));
        let json = serde_json::to_value(&messages).unwrap();
        assert_eq!(json["draftInstruction"], DEFAULT_DRAFT_INSTRUCTION);
        assert_eq!(json["commitInstruction"], DEFAULT_COMMIT_INSTRUCTION);
        assert_eq!(
            json["descriptionInstruction"],
            DEFAULT_DESCRIPTION_INSTRUCTION
        );
    }

    #[test]
    fn commit_agent_messages_add_description_default_to_legacy_config() {
        let messages: CommitAgentMessages = serde_json::from_value(serde_json::json!({
            "draftInstruction": "Custom draft",
            "commitInstruction": "Custom commit"
        }))
        .unwrap();
        assert_eq!(messages.draft_instruction, "Custom draft");
        assert_eq!(messages.commit_instruction, "Custom commit");
        assert_eq!(
            messages.description_instruction,
            DEFAULT_DESCRIPTION_INSTRUCTION
        );
    }

    #[test]
    fn commit_agent_messages_reject_blank_instructions() {
        let messages = CommitAgentMessages {
            draft_instruction: "  ".into(),
            ..CommitAgentMessages::default()
        };
        assert!(!valid_messages(&messages));
    }

    #[test]
    fn commit_draft_rejects_unsafe_tokens() {
        assert_eq!(
            take_commit_draft(".", "../escape").unwrap_err(),
            "Invalid agent draft token."
        );
    }

    #[test]
    fn change_summary_rejects_unsafe_tokens() {
        assert_eq!(
            take_change_summary(".", "../escape").unwrap_err(),
            "Invalid change-summary token."
        );
    }

    #[test]
    fn commit_draft_is_consumed_from_the_git_directory() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("gitlane-agent-draft-{unique}"));
        fs::create_dir_all(&dir).unwrap();
        let repo = git2::Repository::init(&dir).unwrap();
        let draft = repo.path().join("gitlane-commit-draft-safe-token");
        fs::write(&draft, "feat: generated draft\n").unwrap();

        assert_eq!(
            take_commit_draft(dir.to_str().unwrap(), "safe-token").unwrap(),
            Some("feat: generated draft".into())
        );
        assert!(!draft.exists());
        assert_eq!(
            take_commit_draft(dir.to_str().unwrap(), "safe-token").unwrap(),
            None
        );
        drop(repo);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn take_mailbox_sweeps_abandoned_and_empty_deliveries() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("gitlane-mailbox-sweep-{unique}"));
        fs::create_dir_all(&dir).unwrap();
        let repo = git2::Repository::init(&dir).unwrap();
        let git_dir = repo.path().to_path_buf();

        // A late delivery from a request that already timed out (older than the
        // TTL), an empty delivery, and an in-flight `.tmp` sibling.
        let stale = git_dir.join("gitlane-change-summary-abandoned");
        fs::write(&stale, "arrived after the poll gave up").unwrap();
        let old = SystemTime::now() - MAILBOX_TTL - Duration::from_secs(60);
        filetime_set(&stale, old);
        let empty = git_dir.join("gitlane-commit-draft-empty");
        fs::write(&empty, "").unwrap();
        let in_flight_tmp = git_dir.join("gitlane-change-summary-live.tmp");
        fs::write(&in_flight_tmp, "").unwrap();

        // Any consume call sweeps first; the polled token is simply not present.
        assert_eq!(
            take_change_summary(dir.to_str().unwrap(), "live").unwrap(),
            None
        );

        assert!(!stale.exists(), "an abandoned delivery is swept");
        assert!(!empty.exists(), "an empty delivery is swept");
        assert!(
            in_flight_tmp.exists(),
            "a fresh .tmp sibling is left for its rename"
        );

        drop(repo);
        let _ = fs::remove_dir_all(dir);
    }

    fn filetime_set(path: &Path, when: SystemTime) {
        // Backdate the mtime so the file reads as older than MAILBOX_TTL.
        fs::File::open(path).unwrap().set_modified(when).unwrap();
    }

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
                "codex-gpt-5-6-sol-light"
            ]
        );
        let commands: Vec<&str> = d.iter().map(|a| a.command.as_str()).collect();
        assert_eq!(
            commands,
            [
                "claude",
                "codex",
                "claude --model claude-opus-4-8 --effort medium",
                "codex --model gpt-5.6-sol -c 'model_reasoning_effort=\"low\"'"
            ]
        );
        let enabled: Vec<bool> = d.iter().map(|a| a.enabled).collect();
        assert_eq!(enabled, [true, true, false, false]);
        assert!(d.iter().all(|a| !a.description.is_empty()));
    }

    #[test]
    fn migrates_only_the_untouched_legacy_codex_preset() {
        let legacy = AgentEntry {
            id: LEGACY_CODEX_ID.into(),
            name: LEGACY_CODEX_NAME.into(),
            command: LEGACY_CODEX_COMMAND.into(),
            description: "old description".into(),
            enabled: true,
        };
        let mut customized = legacy.clone();
        customized.name = "my codex".into();

        let migrated = migrate_builtin_presets(vec![legacy, customized.clone()]);

        assert_eq!(migrated[0].id, "codex-gpt-5-6-sol-light");
        assert_eq!(migrated[0].name, "codex 5.6 sol light");
        assert_eq!(
            migrated[0].command,
            "codex --model gpt-5.6-sol -c 'model_reasoning_effort=\"low\"'"
        );
        assert!(migrated[0].enabled, "migration preserves the user's toggle");
        assert_eq!(migrated[1].name, customized.name);
        assert_eq!(migrated[1].command, customized.command);
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
