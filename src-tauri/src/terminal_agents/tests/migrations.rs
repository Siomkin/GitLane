use super::super::agents::{
    migrate_builtin_presets, AgentEntry, LEGACY_CODEX_COMMAND, LEGACY_CODEX_ID, LEGACY_CODEX_NAME,
};
use super::super::defaults::*;
use super::super::migrations::{
    merge_draft_and_commit_instructions, migrate_ai_action_commands, migrate_legacy_instruction,
    LEGACY_INSTRUCTIONS,
};
use super::super::*;
use super::action_instruction;

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
