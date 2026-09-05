//! The agent-instruction config (`commit-agent-messages.json`): the
//! [`CommitAgentMessages`] struct, its load/save/reset, and validation.

use super::defaults::{
    default_ai_actions, AiActionCommand, DEFAULT_COMMIT_INSTRUCTION,
    DEFAULT_DESCRIPTION_INSTRUCTION, DEFAULT_DRAFT_INSTRUCTION,
};
use super::migrations::{
    default_description_instruction, deserialize_ai_actions, merge_draft_and_commit_instructions,
    migrate_ai_action_commands, migrate_legacy_instruction,
};
use super::{data_dir, write_atomically};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

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

pub(super) fn messages_config_path_in(dir: &Path) -> PathBuf {
    dir.join("commit-agent-messages.json")
}

/// Load the saved agent instructions. A missing or corrupt config uses the
/// shipped defaults so all agent actions remain usable.
pub fn load_messages(app: &AppHandle) -> CommitAgentMessages {
    match data_dir(app) {
        Ok(dir) => load_messages_in(&dir),
        Err(_) => CommitAgentMessages::default(),
    }
}

pub(super) fn load_messages_in(dir: &Path) -> CommitAgentMessages {
    Some(messages_config_path_in(dir))
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
    save_messages_in(&data_dir(app)?, messages)
}

pub(super) fn save_messages_in(dir: &Path, messages: &CommitAgentMessages) -> Result<(), String> {
    if !valid_messages(messages) {
        return Err("Every instruction is required.".into());
    }
    let json = serde_json::to_string_pretty(messages)
        .map_err(|e| format!("failed to serialize commit agent messages: {e}"))?;
    write_atomically(
        &messages_config_path_in(dir),
        &json,
        "commit agent messages",
    )
}

pub fn reset_messages_to_defaults(app: &AppHandle) -> Result<CommitAgentMessages, String> {
    reset_messages_to_defaults_in(&data_dir(app)?)
}

pub(super) fn reset_messages_to_defaults_in(dir: &Path) -> Result<CommitAgentMessages, String> {
    let messages = CommitAgentMessages::default();
    save_messages_in(dir, &messages)?;
    Ok(messages)
}

pub(super) fn valid_messages(messages: &CommitAgentMessages) -> bool {
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
