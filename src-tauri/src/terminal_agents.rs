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
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const LEGACY_CODEX_ID: &str = "codex-gpt-5-5-medium";
const LEGACY_CODEX_NAME: &str = "codex 5.5 medium";
const LEGACY_CODEX_COMMAND: &str = "codex --model gpt-5.5 -c 'model_reasoning_effort=\"medium\"'";

// Draft / Improve (ACP) and Commit with agent (terminal) share this. The
// call site adds the mode: ACP asks for the message only; the terminal path
// asks the agent to commit. "Add a body … unless the change is small"
// replaced "add a short body only if the subject cannot carry it", which had
// agents answering with a bare subject even for large diffs.
pub const DEFAULT_DRAFT_INSTRUCTION: &str =
    "Read the staged diff once (`git diff --staged`) and write a conventional commit message. Do not open files, run tests, or search the codebase — the diff is the only evidence. Subject under 72 characters. Add a body explaining what changed and why, wrapped at 72 columns, unless the change is small enough that the subject already says everything.";
pub const DEFAULT_COMMIT_INSTRUCTION: &str = DEFAULT_DRAFT_INSTRUCTION;
pub const DEFAULT_DESCRIPTION_INSTRUCTION: &str =
    "Summarize what the changes do and why, in at most 4 sentences or 5 short bullets. Read the diff only — do not open other files, run tests, or search the codebase. This is a quick summary, not a code review: no quality findings, no risk analysis, no file-by-file inventory. Be fast.";
pub const DEFAULT_AI_ACTION_SHORT: &str =
    "Write a concise summary of what changed and why it matters, in at most 4 sentences or 5 short bullets. Use Markdown — a short paragraph, or a bullet list when that is clearer. Include enough detail to understand the main behavior and important effects. No preamble or file-by-file inventory. Reply with the Markdown and nothing else.";
pub const DEFAULT_AI_ACTION_FULL: &str =
    "Write a clear Markdown description of what changed, why it was needed, and how the main pieces work together. Use short headings and bullets where they help scanning. Include user-visible behavior, important implementation choices, and relevant limitations or trade-offs when supported by the diff. Use enough detail to make the change understandable without turning it into a file-by-file inventory. Reply with the Markdown and nothing else.";
pub const DEFAULT_AI_ACTION_IMPL: &str =
    "Write a practical implementation update for developers, product, and QA as Markdown. Use short headings and bullets. Explain the problem, the solution, and any behavior or contract impact. Include validation evidence, QA actions with expected results, real risks, and follow-ups only when relevant. Omit empty sections and file-by-file inventories, and do not claim tests ran unless the evidence says so. Reply with the Markdown and nothing else.";
pub const DEFAULT_AI_ACTION_RELEASE: &str =
    "Write release-note entries for people who use the product as Markdown bullets. Explain every meaningful user-visible outcome and why it is useful in plain language, without implementation details. Omit refactors, tests, and other internal-only work. If there is no user-visible change, say so plainly. Reply with the Markdown and nothing else.";
pub const DEFAULT_AI_ACTION_REVIEW: &str =
    "Review the diff for concrete defects that could break behavior, lose data, weaken security, or cause regressions. Report only actionable findings supported by the diff, highest impact first, as a Markdown list. For each finding, name the affected area, explain the failure scenario, and suggest the smallest fix. Skip summaries, praise, style preferences, speculative concerns, and low-risk observations. Reply with the Markdown and nothing else; if there are none, reply exactly: No actionable findings.";
pub const DEFAULT_AI_ACTION_TEST: &str =
    "Write a focused numbered Markdown test plan for the behavior affected by this change. Cover the main path plus edge cases and regressions that are relevant to the diff, not generic checks. Each step must say what to do and what result to expect. Include setup only when needed, and do not invent UI paths, data, or prerequisites. Reply with the Markdown and nothing else.";
pub const DEFAULT_AI_ACTION_SHORT_TITLE: &str = "Short description";
pub const DEFAULT_AI_ACTION_FULL_TITLE: &str = "Full description";
pub const DEFAULT_AI_ACTION_IMPL_TITLE: &str = "Implementation comment";
pub const DEFAULT_AI_ACTION_RELEASE_TITLE: &str = "Release notes";
pub const DEFAULT_AI_ACTION_REVIEW_TITLE: &str = "Review & risk";
pub const DEFAULT_AI_ACTION_TEST_TITLE: &str = "Test plan";

const BUILTIN_AI_ACTION_IDS: [&str; 6] = ["short", "full", "impl", "release", "review", "test"];

/// Instructions GitLane used to ship. A saved config holding one of these
/// verbatim is an untouched old default, not a user preference, so it migrates
/// to the current text on load — otherwise every existing user keeps the old
/// prompt until they find "Reset" in Settings. Anything edited stays as the
/// user wrote it.
///
/// Add old shipped text here whenever a default changes. Exact matches migrate;
/// anything the user edited remains untouched.
const LEGACY_INSTRUCTIONS: [&str; 21] = [
    "Review the staged changes and draft a concise conventional commit message.",
    "Review the staged changes, write a concise conventional-commit message, and commit them.",
    "Write a clear plain-text explanation of what the changes do and why they matter. Cover the main behavior, important implementation details, and notable effects or risks. Use as much detail as needed to make the changes understandable, while avoiding repetition or a file-by-file inventory.",
    "Read the staged diff once (`git diff --staged`) and write a conventional commit message. Do not open files, run tests, search the codebase, or review the code — be fast. Subject under 72 characters; add a short body only if the subject cannot carry it.",
    "Read the staged diff once (`git diff --staged`), write a conventional commit message, and commit. Do not open files, run tests, search the codebase, or review the code — be fast. Subject under 72 characters; add a short body only if the subject cannot carry it.",
    "Write an implementation summary in Markdown with these sections: `## Summary` (2-3 sentences), `## Changes` (bullets, each naming the file or module it touches), `## How to test` (numbered steps a reviewer can follow), and `## Risk` (one short paragraph). Reply with the Markdown and nothing else.",
    "Write one sentence saying what the change does. No preamble, no bullet list, no file inventory. Reply with the sentence and nothing else.",
    "Write a description of the change in at most three short paragraphs: what it does, how it works, and anything a reader would otherwise be surprised by. No headings, no file-by-file inventory. Reply with the description and nothing else.",
    "Write a Jira implementation comment for developers, PM, and QA. Reply with the comment and nothing else. Format for Jira's visual editor: bold section titles (not markdown # headings), plain dash bullets (never checkboxes), no fenced code blocks, inline code for paths and names. Omit any section that does not apply. Never pad. Start with a bold title (ticket key and short name when a key is named in this prompt). Then **What was done** (1-3 sentences: the problem and what the change did, readable by PM and QA). Then **Important changes** (bullets of user-visible or QA-relevant behavior, not implementation trivia). Include only when relevant: **Database**, **API / contracts**, **New files / classes**, **Tests** (what was added and whether they ran), **QA checklist** (2-5 grouped scenarios such as Happy path, Validation, Regression, with exact UI paths, actions, and expected results — no vague 'test that it works'), **Needs attention** (real risks only), **Future refactoring / tech debt**.",
    "Write the release-note entries for this change as Markdown bullets, one per user-visible change, each phrased for someone who uses the app and has not read the code. Omit internal refactors that change nothing a user can see. Reply with the bullets and nothing else.",
    "List what a reviewer should look at closely: correctness risks, missed cases, and anything the change leaves inconsistent. Be specific — name the file and what could go wrong. Say plainly when a part looks low risk. Reply with the findings and nothing else.",
    "Write a numbered manual test plan for this change: the steps to run, and what to expect at each one. Cover the main path and the edge cases the change introduces. Reply with the plan and nothing else.",
    "Summarize the change in one sentence, focusing on what changed and why it matters. No preamble, bullets, or file inventory. Reply with the sentence and nothing else.",
    "Read the staged diff once (`git diff --staged`) and write a conventional commit message. Do not open files, run tests, or search the codebase — the diff is the only evidence. Subject under 72 characters. Add a body explaining what changed and why, wrapped at 72 columns, unless the change is small enough that the subject already says everything. Reply with the commit message and nothing else.",
    "Read the staged diff once (`git diff --staged`), write a conventional commit message, and commit. Do not open files, run tests, or search the codebase — the diff is the only evidence. Subject under 72 characters. Add a body explaining what changed and why, wrapped at 72 columns, unless the change is small enough that the subject already says everything.",
    "Write a concise summary of what changed and why it matters. Include enough detail to understand the main behavior and important effects; use a short paragraph or a few bullets when that is clearer. No preamble or file-by-file inventory. Reply with the summary and nothing else.",
    "Write a clear description of what changed, why it was needed, and how the main pieces work together. Include user-visible behavior, important implementation choices, and relevant limitations or trade-offs when supported by the diff. Use enough detail to make the change understandable without turning it into a file-by-file inventory. Reply with the description and nothing else.",
    "Write a practical implementation update for developers, product, and QA. Explain the problem, the solution, and any behavior or contract impact. Include validation evidence, QA actions with expected results, real risks, and follow-ups only when relevant. Use short sections or bullets when they help, omit empty sections and file-by-file inventories, and do not claim tests ran unless the evidence says so. Reply with the update and nothing else.",
    "Write release-note entries for people who use the product. Explain every meaningful user-visible outcome and why it is useful in plain language, without implementation details. Omit refactors, tests, and other internal-only work. If there is no user-visible change, say so plainly. Reply with the release notes and nothing else.",
    "Review the diff for concrete defects that could break behavior, lose data, weaken security, or cause regressions. Report only actionable findings supported by the diff, highest impact first. For each finding, name the affected area, explain the failure scenario, and suggest the smallest fix. Skip summaries, praise, style preferences, speculative concerns, and low-risk observations. Reply with the findings and nothing else; if there are none, reply exactly: No actionable findings.",
    "Write a focused numbered manual test plan for the behavior affected by this change. Cover the main path plus edge cases and regressions that are relevant to the diff, not generic checks. Each step must say what to do and what result to expect. Include setup only when needed, and do not invent UI paths, data, or prerequisites. Reply with the plan and nothing else.",
];

fn default_description_instruction() -> String {
    DEFAULT_DESCRIPTION_INSTRUCTION.into()
}

fn migrate_legacy_instruction(saved: &mut String, current_default: &str) {
    if LEGACY_INSTRUCTIONS.contains(&saved.as_str()) {
        *saved = current_default.into();
    }
}

/// Draft and Commit were separate prompts; they are now one editable field.
/// Fold them here, at load, rather than letting a save quietly overwrite one
/// with the other: a user who only ever customized the commit prompt would
/// otherwise lose that text the first time they toggled an AI action.
///
/// The customized text wins. When both were customized the draft prompt wins,
/// because that is the one the Prompts panel now shows and edits.
fn merge_draft_and_commit_instructions(messages: &mut CommitAgentMessages) {
    if messages.commit_instruction == messages.draft_instruction {
        return;
    }
    if messages.draft_instruction == DEFAULT_DRAFT_INSTRUCTION {
        messages.draft_instruction = messages.commit_instruction.clone();
    }
    messages.commit_instruction = messages.draft_instruction.clone();
}

/// One AI-actions popup command: a picker label plus the prompt sent to the
/// agent. Builtins use stable ids (`short`, `full`, …); user-added rows use a
/// uuid. Disabled rows stay in the config but hide from the picker.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiActionCommand {
    pub id: String,
    pub title: String,
    pub instruction: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn ai_action_command(id: &str, title: &str, instruction: &str) -> AiActionCommand {
    AiActionCommand {
        id: id.into(),
        title: title.into(),
        instruction: instruction.into(),
        enabled: true,
    }
}

fn builtin_ai_action(id: &str) -> Option<AiActionCommand> {
    match id {
        "short" => Some(ai_action_command(
            "short",
            DEFAULT_AI_ACTION_SHORT_TITLE,
            DEFAULT_AI_ACTION_SHORT,
        )),
        "full" => Some(ai_action_command(
            "full",
            DEFAULT_AI_ACTION_FULL_TITLE,
            DEFAULT_AI_ACTION_FULL,
        )),
        "impl" => Some(ai_action_command(
            "impl",
            DEFAULT_AI_ACTION_IMPL_TITLE,
            DEFAULT_AI_ACTION_IMPL,
        )),
        "release" => Some(ai_action_command(
            "release",
            DEFAULT_AI_ACTION_RELEASE_TITLE,
            DEFAULT_AI_ACTION_RELEASE,
        )),
        "review" => Some(ai_action_command(
            "review",
            DEFAULT_AI_ACTION_REVIEW_TITLE,
            DEFAULT_AI_ACTION_REVIEW,
        )),
        "test" => Some(ai_action_command(
            "test",
            DEFAULT_AI_ACTION_TEST_TITLE,
            DEFAULT_AI_ACTION_TEST,
        )),
        _ => None,
    }
}

fn default_ai_actions() -> Vec<AiActionCommand> {
    BUILTIN_AI_ACTION_IDS
        .iter()
        .filter_map(|id| builtin_ai_action(id))
        .collect()
}

/// The six-string object shipped before AI actions became a list.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyAiActionInstructions {
    short: String,
    full: String,
    #[serde(rename = "impl")]
    implementation: String,
    release: String,
    review: String,
    test: String,
}

impl LegacyAiActionInstructions {
    fn into_commands(self) -> Vec<AiActionCommand> {
        vec![
            ai_action_command("short", DEFAULT_AI_ACTION_SHORT_TITLE, &self.short),
            ai_action_command("full", DEFAULT_AI_ACTION_FULL_TITLE, &self.full),
            ai_action_command("impl", DEFAULT_AI_ACTION_IMPL_TITLE, &self.implementation),
            ai_action_command("release", DEFAULT_AI_ACTION_RELEASE_TITLE, &self.release),
            ai_action_command("review", DEFAULT_AI_ACTION_REVIEW_TITLE, &self.review),
            ai_action_command("test", DEFAULT_AI_ACTION_TEST_TITLE, &self.test),
        ]
    }
}

fn deserialize_ai_actions<'de, D>(deserializer: D) -> Result<Vec<AiActionCommand>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Raw {
        List(Vec<AiActionCommand>),
        Legacy(LegacyAiActionInstructions),
    }
    Ok(match Raw::deserialize(deserializer)? {
        Raw::List(list) => list,
        Raw::Legacy(legacy) => legacy.into_commands(),
    })
}

fn migrate_ai_action_commands(saved: &mut Vec<AiActionCommand>) {
    for command in saved.iter_mut() {
        if let Some(builtin) = builtin_ai_action(&command.id) {
            migrate_legacy_instruction(&mut command.instruction, &builtin.instruction);
        }
    }
    let missing: Vec<&str> = BUILTIN_AI_ACTION_IDS
        .into_iter()
        .filter(|id| saved.iter().all(|command| command.id != *id))
        .collect();
    for id in missing {
        if let Some(command) = builtin_ai_action(id) {
            saved.push(command);
        }
    }
}

/// User-editable instructions for the in-app agent actions (Draft / Improve,
/// Commit with agent, Describe changes, AI actions). These are the whole prompt
/// now that delivery rides the ACP protocol rather than a mailbox contract.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitAgentMessages {
    pub draft_instruction: String,
    pub commit_instruction: String,
    #[serde(default = "default_description_instruction")]
    pub description_instruction: String,
    #[serde(
        default = "default_ai_actions",
        deserialize_with = "deserialize_ai_actions"
    )]
    pub ai_actions: Vec<AiActionCommand>,
}

impl Default for CommitAgentMessages {
    fn default() -> Self {
        Self {
            draft_instruction: DEFAULT_DRAFT_INSTRUCTION.into(),
            commit_instruction: DEFAULT_COMMIT_INSTRUCTION.into(),
            description_instruction: DEFAULT_DESCRIPTION_INSTRUCTION.into(),
            ai_actions: default_ai_actions(),
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
        .map(|mut messages| {
            migrate_legacy_instruction(&mut messages.draft_instruction, DEFAULT_DRAFT_INSTRUCTION);
            migrate_legacy_instruction(
                &mut messages.commit_instruction,
                DEFAULT_COMMIT_INSTRUCTION,
            );
            migrate_legacy_instruction(
                &mut messages.description_instruction,
                DEFAULT_DESCRIPTION_INSTRUCTION,
            );
            merge_draft_and_commit_instructions(&mut messages);
            migrate_ai_action_commands(&mut messages.ai_actions);
            messages
        })
        .unwrap_or_default()
}

/// Persist all instructions atomically. Blank instructions are rejected at
/// the IPC boundary even though the Settings UI also validates them.
pub fn save_messages(app: &AppHandle, messages: &CommitAgentMessages) -> Result<(), String> {
    if !valid_messages(messages) {
        return Err("Every instruction is required.".into());
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
        && valid_ai_actions(&messages.ai_actions)
}

fn valid_ai_actions(actions: &[AiActionCommand]) -> bool {
    let mut ids = HashSet::new();
    actions.iter().all(|command| {
        !command.id.trim().is_empty()
            && ids.insert(command.id.as_str())
            && (!command.enabled
                || (!command.title.trim().is_empty() && !command.instruction.trim().is_empty()))
    })
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

    fn action_instruction<'a>(messages: &'a CommitAgentMessages, id: &str) -> &'a str {
        &messages
            .ai_actions
            .iter()
            .find(|command| command.id == id)
            .unwrap_or_else(|| panic!("missing {id}"))
            .instruction
    }

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
        assert_eq!(json["aiActions"][0]["id"], "short");
        assert_eq!(json["aiActions"][0]["title"], DEFAULT_AI_ACTION_SHORT_TITLE);
        assert_eq!(json["aiActions"][0]["instruction"], DEFAULT_AI_ACTION_SHORT);
        assert_eq!(json["aiActions"][2]["id"], "impl");
        assert_eq!(json["aiActions"][2]["instruction"], DEFAULT_AI_ACTION_IMPL);
    }

    #[test]
    fn legacy_shipped_instructions_migrate_but_user_edits_survive() {
        let mut untouched = LEGACY_INSTRUCTIONS[0].to_string();
        migrate_legacy_instruction(&mut untouched, DEFAULT_DRAFT_INSTRUCTION);
        assert_eq!(untouched, DEFAULT_DRAFT_INSTRUCTION);

        // A customised instruction is a preference, not a stale default.
        let mut edited = format!("{} Always mention the ticket.", LEGACY_INSTRUCTIONS[0]);
        let before = edited.clone();
        migrate_legacy_instruction(&mut edited, DEFAULT_DRAFT_INSTRUCTION);
        assert_eq!(edited, before);
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
        assert_eq!(
            action_instruction(&messages, "short"),
            DEFAULT_AI_ACTION_SHORT
        );
        assert_eq!(
            action_instruction(&messages, "impl"),
            DEFAULT_AI_ACTION_IMPL
        );
    }

    #[test]
    fn folding_draft_and_commit_keeps_the_customized_prompt() {
        // Draft and Commit are one field now. A user who only ever customized
        // the commit prompt must keep that text, not silently inherit the
        // shipped draft default.
        let mut commit_only: CommitAgentMessages = serde_json::from_value(serde_json::json!({
            "draftInstruction": DEFAULT_DRAFT_INSTRUCTION,
            "commitInstruction": "Custom commit",
        }))
        .unwrap();
        merge_draft_and_commit_instructions(&mut commit_only);
        assert_eq!(commit_only.draft_instruction, "Custom commit");
        assert_eq!(commit_only.commit_instruction, "Custom commit");

        // Both customized: the draft prompt wins, because that is the one the
        // Prompts panel shows and edits.
        let mut both: CommitAgentMessages = serde_json::from_value(serde_json::json!({
            "draftInstruction": "Custom draft",
            "commitInstruction": "Custom commit",
        }))
        .unwrap();
        merge_draft_and_commit_instructions(&mut both);
        assert_eq!(both.draft_instruction, "Custom draft");
        assert_eq!(both.commit_instruction, "Custom draft");
    }

    #[test]
    fn commit_instructions_ask_for_a_body() {
        // Both agents obeyed "only if the subject cannot carry it" and returned
        // a bare subject even for an 18-file diff. The default now asks for a
        // body outright, with "small enough" as the only escape.
        for instruction in [DEFAULT_DRAFT_INSTRUCTION, DEFAULT_COMMIT_INSTRUCTION] {
            assert!(instruction.contains("Add a body explaining what changed and why"));
            assert!(!instruction.contains("only if the subject cannot carry it"));
        }
        assert_eq!(DEFAULT_DRAFT_INSTRUCTION, DEFAULT_COMMIT_INSTRUCTION);
    }

    #[test]
    fn the_body_suppressing_defaults_migrate_off_a_saved_config() {
        // The exact text every existing install has saved right now.
        let saved = serde_json::json!({
            "draftInstruction": LEGACY_INSTRUCTIONS[3],
            "commitInstruction": LEGACY_INSTRUCTIONS[4],
            "descriptionInstruction": DEFAULT_DESCRIPTION_INSTRUCTION,
        });
        let mut messages: CommitAgentMessages = serde_json::from_value(saved).unwrap();
        migrate_legacy_instruction(&mut messages.draft_instruction, DEFAULT_DRAFT_INSTRUCTION);
        migrate_legacy_instruction(&mut messages.commit_instruction, DEFAULT_COMMIT_INSTRUCTION);

        assert_eq!(messages.draft_instruction, DEFAULT_DRAFT_INSTRUCTION);
        assert_eq!(messages.commit_instruction, DEFAULT_COMMIT_INSTRUCTION);
    }

    #[test]
    fn the_split_commit_message_defaults_migrate_onto_the_shared_prompt() {
        let saved = serde_json::json!({
            "draftInstruction": LEGACY_INSTRUCTIONS[13],
            "commitInstruction": LEGACY_INSTRUCTIONS[14],
            "descriptionInstruction": DEFAULT_DESCRIPTION_INSTRUCTION,
        });
        let mut messages: CommitAgentMessages = serde_json::from_value(saved).unwrap();
        migrate_legacy_instruction(&mut messages.draft_instruction, DEFAULT_DRAFT_INSTRUCTION);
        migrate_legacy_instruction(&mut messages.commit_instruction, DEFAULT_COMMIT_INSTRUCTION);

        assert_eq!(messages.draft_instruction, DEFAULT_DRAFT_INSTRUCTION);
        assert_eq!(messages.commit_instruction, DEFAULT_COMMIT_INSTRUCTION);
        assert_eq!(messages.draft_instruction, messages.commit_instruction);
    }

    #[test]
    fn the_markdown_impl_default_migrates_off_a_saved_config() {
        let saved = serde_json::json!({
            "draftInstruction": DEFAULT_DRAFT_INSTRUCTION,
            "commitInstruction": DEFAULT_COMMIT_INSTRUCTION,
            "descriptionInstruction": DEFAULT_DESCRIPTION_INSTRUCTION,
            "aiActions": {
                "short": DEFAULT_AI_ACTION_SHORT,
                "full": DEFAULT_AI_ACTION_FULL,
                "impl": LEGACY_INSTRUCTIONS[5],
                "release": DEFAULT_AI_ACTION_RELEASE,
                "review": DEFAULT_AI_ACTION_REVIEW,
                "test": DEFAULT_AI_ACTION_TEST,
            }
        });
        let mut messages: CommitAgentMessages = serde_json::from_value(saved).unwrap();
        migrate_ai_action_commands(&mut messages.ai_actions);
        assert_eq!(
            action_instruction(&messages, "impl"),
            DEFAULT_AI_ACTION_IMPL
        );
    }

    #[test]
    fn the_previous_ai_action_defaults_migrate_off_a_saved_config() {
        let saved = serde_json::json!({
            "draftInstruction": DEFAULT_DRAFT_INSTRUCTION,
            "commitInstruction": DEFAULT_COMMIT_INSTRUCTION,
            "descriptionInstruction": DEFAULT_DESCRIPTION_INSTRUCTION,
            "aiActions": {
                "short": LEGACY_INSTRUCTIONS[12],
                "full": LEGACY_INSTRUCTIONS[7],
                "impl": LEGACY_INSTRUCTIONS[8],
                "release": LEGACY_INSTRUCTIONS[9],
                "review": LEGACY_INSTRUCTIONS[10],
                "test": LEGACY_INSTRUCTIONS[11],
            }
        });
        let mut messages: CommitAgentMessages = serde_json::from_value(saved).unwrap();
        migrate_ai_action_commands(&mut messages.ai_actions);
        assert_eq!(messages.ai_actions, default_ai_actions());
    }

    #[test]
    fn the_plain_prose_ai_action_defaults_migrate_off_a_saved_config() {
        let saved = serde_json::json!({
            "draftInstruction": DEFAULT_DRAFT_INSTRUCTION,
            "commitInstruction": DEFAULT_COMMIT_INSTRUCTION,
            "descriptionInstruction": DEFAULT_DESCRIPTION_INSTRUCTION,
            "aiActions": {
                "short": LEGACY_INSTRUCTIONS[15],
                "full": LEGACY_INSTRUCTIONS[16],
                "impl": LEGACY_INSTRUCTIONS[17],
                "release": LEGACY_INSTRUCTIONS[18],
                "review": LEGACY_INSTRUCTIONS[19],
                "test": LEGACY_INSTRUCTIONS[20],
            }
        });
        let mut messages: CommitAgentMessages = serde_json::from_value(saved).unwrap();
        migrate_ai_action_commands(&mut messages.ai_actions);
        assert_eq!(messages.ai_actions, default_ai_actions());
    }

    #[test]
    fn a_saved_ai_action_list_keeps_user_rows_and_appends_a_missing_builtin() {
        let saved = serde_json::json!({
            "draftInstruction": DEFAULT_DRAFT_INSTRUCTION,
            "commitInstruction": DEFAULT_COMMIT_INSTRUCTION,
            "descriptionInstruction": DEFAULT_DESCRIPTION_INSTRUCTION,
            "aiActions": [
                {
                    "id": "short",
                    "title": "Short description",
                    "instruction": DEFAULT_AI_ACTION_SHORT,
                    "enabled": false
                },
                {
                    "id": "mine",
                    "title": "Jira comment",
                    "instruction": "Write the ticket comment.",
                    "enabled": true
                }
            ]
        });
        let mut messages: CommitAgentMessages = serde_json::from_value(saved).unwrap();
        migrate_ai_action_commands(&mut messages.ai_actions);
        assert_eq!(messages.ai_actions[0].id, "short");
        assert!(!messages.ai_actions[0].enabled);
        assert_eq!(messages.ai_actions[1].id, "mine");
        assert_eq!(messages.ai_actions[1].title, "Jira comment");
        let ids: Vec<&str> = messages.ai_actions.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(
            ids,
            ["short", "mine", "full", "impl", "release", "review", "test"]
        );
    }

    #[test]
    fn enabled_ai_actions_need_a_title_and_prompt() {
        let mut messages = CommitAgentMessages::default();
        messages.ai_actions[0].title = "  ".into();
        assert!(!valid_messages(&messages));
        messages.ai_actions[0].title = "Short description".into();
        messages.ai_actions[0].enabled = false;
        messages.ai_actions[0].instruction = String::new();
        assert!(valid_messages(&messages));
    }

    #[test]
    fn ai_action_defaults_are_platform_neutral_and_actionable() {
        for instruction in [
            DEFAULT_AI_ACTION_SHORT,
            DEFAULT_AI_ACTION_FULL,
            DEFAULT_AI_ACTION_IMPL,
            DEFAULT_AI_ACTION_RELEASE,
            DEFAULT_AI_ACTION_REVIEW,
            DEFAULT_AI_ACTION_TEST,
        ] {
            assert!(!instruction.contains("Jira"));
            assert!(!instruction.contains("GitHub"));
            assert!(instruction.contains("Reply with"));
        }
        assert!(DEFAULT_AI_ACTION_SHORT.contains("enough detail"));
        assert!(DEFAULT_AI_ACTION_SHORT.contains("4 sentences or 5 short bullets"));
        assert!(DEFAULT_AI_ACTION_FULL.contains("enough detail"));
        assert!(DEFAULT_AI_ACTION_IMPL.contains("developers, product, and QA"));
        assert!(DEFAULT_AI_ACTION_IMPL.contains("do not claim tests ran"));
        assert!(DEFAULT_AI_ACTION_RELEASE.contains("every meaningful user-visible outcome"));
        assert!(DEFAULT_AI_ACTION_REVIEW.contains("No actionable findings"));
        assert!(DEFAULT_AI_ACTION_REVIEW.contains("Skip summaries"));
        assert!(DEFAULT_AI_ACTION_TEST.contains("not generic checks"));
        assert!(DEFAULT_AI_ACTION_TEST.contains("what result to expect"));
        for instruction in [
            DEFAULT_AI_ACTION_SHORT,
            DEFAULT_AI_ACTION_FULL,
            DEFAULT_AI_ACTION_IMPL,
            DEFAULT_AI_ACTION_RELEASE,
            DEFAULT_AI_ACTION_REVIEW,
            DEFAULT_AI_ACTION_TEST,
        ] {
            assert!(instruction.contains("Markdown"));
        }
    }

    #[test]
    fn every_legacy_instruction_is_a_text_we_no_longer_ship() {
        // A current default listed as legacy would migrate onto itself forever
        // and, worse, silently overwrite a user who typed today's wording.
        for legacy in LEGACY_INSTRUCTIONS {
            assert_ne!(legacy, DEFAULT_DRAFT_INSTRUCTION);
            assert_ne!(legacy, DEFAULT_COMMIT_INSTRUCTION);
            assert_ne!(legacy, DEFAULT_DESCRIPTION_INSTRUCTION);
            for current in [
                DEFAULT_AI_ACTION_SHORT,
                DEFAULT_AI_ACTION_FULL,
                DEFAULT_AI_ACTION_IMPL,
                DEFAULT_AI_ACTION_RELEASE,
                DEFAULT_AI_ACTION_REVIEW,
                DEFAULT_AI_ACTION_TEST,
            ] {
                assert_ne!(legacy, current);
            }
        }
    }

    #[test]
    fn the_frontend_default_copies_match_these_byte_for_byte() {
        // `src/store/commitAgentMessages.ts` repeats these defaults so the
        // actions work before the first backend load lands. Migration matches
        // saved text by exact equality, so a copy that drifts would leave the
        // user staring at wording the backend can never recognise or migrate.
        let ts = include_str!("../../src/store/commitAgentMessages.ts");
        for (name, value) in [
            ("draftInstruction", DEFAULT_DRAFT_INSTRUCTION),
            ("commitInstruction", DEFAULT_COMMIT_INSTRUCTION),
            ("descriptionInstruction", DEFAULT_DESCRIPTION_INSTRUCTION),
            ("short", DEFAULT_AI_ACTION_SHORT),
            ("full", DEFAULT_AI_ACTION_FULL),
            ("impl", DEFAULT_AI_ACTION_IMPL),
            ("release", DEFAULT_AI_ACTION_RELEASE),
            ("review", DEFAULT_AI_ACTION_REVIEW),
            ("test", DEFAULT_AI_ACTION_TEST),
            ("Short description", DEFAULT_AI_ACTION_SHORT_TITLE),
            ("Full description", DEFAULT_AI_ACTION_FULL_TITLE),
            ("Implementation comment", DEFAULT_AI_ACTION_IMPL_TITLE),
            ("Release notes", DEFAULT_AI_ACTION_RELEASE_TITLE),
            ("Review & risk", DEFAULT_AI_ACTION_REVIEW_TITLE),
            ("Test plan", DEFAULT_AI_ACTION_TEST_TITLE),
        ] {
            assert!(
                ts.contains(value),
                "{name} in commitAgentMessages.ts has drifted from the Rust default",
            );
        }
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
