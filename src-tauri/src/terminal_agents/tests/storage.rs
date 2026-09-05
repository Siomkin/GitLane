use super::super::agents::{
    config_path_in, defaults, load_in, reset_to_defaults_in, save_in, AgentEntry,
};
use super::super::defaults::*;
use super::super::messages::{
    load_messages_in, messages_config_path_in, reset_messages_to_defaults_in, save_messages_in,
    valid_messages,
};
use super::super::*;
use super::action_instruction;

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
fn the_frontend_default_copies_match_these_byte_for_byte() {
    // `src/store/commitAgentMessages.ts` repeats these defaults so the
    // actions work before the first backend load lands. Migration matches
    // saved text by exact equality, so a copy that drifts would leave the
    // user staring at wording the backend can never recognise or migrate.
    let ts = include_str!("../../../../src/store/commitAgentMessages.ts");
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

/// A throwaway data dir that cleans itself up on drop — the same
/// dependency-free shape the git write tests use, so no `tempfile` dev-dep.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("gitlane-term-{tag}-{}-{n}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn agent(id: &str) -> TerminalAgent {
    TerminalAgent {
        id: id.to_string(),
        name: id.to_string(),
        command: id.to_string(),
        description: String::new(),
        enabled: true,
        available: true,
    }
}

#[test]
fn save_then_load_round_trips_the_agent_list() {
    let dir = TempDir::new("round-trip");

    save_in(&dir.0, &[agent("claude"), agent("codex")]).unwrap();
    let loaded = load_in(&dir.0);

    let ids: Vec<&str> = loaded.iter().map(|a| a.id.as_str()).collect();
    assert!(ids.contains(&"claude") && ids.contains(&"codex"));
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
fn a_corrupt_agent_config_falls_back_to_defaults_rather_than_panicking() {
    let dir = TempDir::new("corrupt");
    fs::write(config_path_in(&dir.0), "{not json").unwrap();

    let loaded = load_in(&dir.0);

    // The toolbar must always render, so a corrupt file seeds defaults.
    assert!(!loaded.is_empty());
}

#[test]
fn reset_to_defaults_overwrites_a_customised_agent_list() {
    let dir = TempDir::new("reset");
    save_in(&dir.0, &[agent("hand-written")]).unwrap();

    let after = reset_to_defaults_in(&dir.0).unwrap();

    assert!(after.iter().all(|a| a.id != "hand-written"));
    assert_eq!(load_in(&dir.0).len(), after.len());
}

#[test]
fn messages_round_trip_and_reset_restores_the_shipped_defaults() {
    let dir = TempDir::new("messages");
    let messages = CommitAgentMessages {
        draft_instruction: "my own draft instruction".to_string(),
        ..Default::default()
    };

    save_messages_in(&dir.0, &messages).unwrap();
    assert_eq!(
        load_messages_in(&dir.0).draft_instruction,
        "my own draft instruction"
    );

    let after = reset_messages_to_defaults_in(&dir.0).unwrap();

    assert_eq!(after.draft_instruction, DEFAULT_DRAFT_INSTRUCTION);
    assert_eq!(
        load_messages_in(&dir.0).draft_instruction,
        DEFAULT_DRAFT_INSTRUCTION
    );
}

#[test]
fn a_blank_instruction_is_rejected_and_leaves_the_saved_messages_alone() {
    let dir = TempDir::new("blank");
    save_messages_in(&dir.0, &CommitAgentMessages::default()).unwrap();
    let blank = CommitAgentMessages {
        commit_instruction: "   ".to_string(),
        ..Default::default()
    };

    let err = save_messages_in(&dir.0, &blank).unwrap_err();

    assert!(err.contains("required"));
    assert_eq!(
        load_messages_in(&dir.0).commit_instruction,
        DEFAULT_COMMIT_INSTRUCTION,
        "the rejected write must not have touched the file"
    );
}

#[test]
fn corrupt_messages_fall_back_to_the_shipped_defaults() {
    let dir = TempDir::new("bad-messages");
    fs::write(messages_config_path_in(&dir.0), "{not json").unwrap();

    assert_eq!(
        load_messages_in(&dir.0).draft_instruction,
        DEFAULT_DRAFT_INSTRUCTION
    );
}
