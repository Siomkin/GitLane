//! Pinning the model and its dependent config options before prompting.

use super::support::*;

#[test]
fn pins_the_session_to_a_model_before_prompting() {
    let mut sent = Vec::new();
    let reader = transcript_for(
        SESSION_WITH_MODELS,
        &[r#"{"jsonrpc":"2.0","id":3,"result":{}}"#, &chunk("ok")],
        4,
        "end_turn",
    );
    let text = run_session(
        reader,
        &mut sent,
        Turn {
            cwd: &PathBuf::from("/repo"),
            model: "gpt-5.6-sol[low]",
            config: &BTreeMap::new(),
            text: "describe this",
            launch_pinned: false,
            progress: &|_| {},
        },
    )
    .unwrap();
    assert_eq!(text, "ok");
    assert_eq!(
        requests(&sent),
        [
            (1, "initialize".into()),
            (2, "session/new".into()),
            (3, "session/set_model".into()),
            (4, "session/prompt".into()),
        ]
    );
    // The effort suffix is part of the id — dropping it would silently
    // downgrade a "sol light" preset to the adapter's default effort.
    let set = request_params(&sent, 3);
    assert_eq!(set["modelId"], "gpt-5.6-sol[low]");
    assert_eq!(set["sessionId"], "sess_1");
}

#[test]
fn pins_a_model_through_the_session_config_option() {
    // Most adapters expose their models this way rather than as
    // `models.availableModels`; reading only the latter made them look like
    // they offered no model choice at all.
    let mut sent = Vec::new();
    let reader = transcript_for(
        SESSION_WITH_CONFIG_OPTION,
        &[
            r#"{"jsonrpc":"2.0","id":3,"result":{"configOptions":[]}}"#,
            &part("m1", "ok"),
        ],
        4,
        "end_turn",
    );
    let text = run_session(
        reader,
        &mut sent,
        Turn {
            cwd: &PathBuf::from("/repo"),
            model: "haiku",
            config: &BTreeMap::new(),
            text: "describe this",
            launch_pinned: false,
            progress: &|_| {},
        },
    )
    .unwrap();
    assert_eq!(text, "ok");
    assert_eq!(
        requests(&sent),
        [
            (1, "initialize".into()),
            (2, "session/new".into()),
            (3, "session/set_config_option".into()),
            (4, "session/prompt".into()),
        ]
    );
    let set = request_params(&sent, 3);
    assert_eq!(set["configId"], "model");
    assert_eq!(set["value"], "haiku");
}

#[test]
fn pins_effort_and_fast_config_options_before_prompting() {
    let mut sent = Vec::new();
    // Each set_config_option returns the complete config list (ACP contract).
    let after = r#"{"configOptions":[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"haiku","options":[{"value":"opus[1m]","name":"Opus"},{"value":"haiku","name":"Haiku"}]},{"id":"effort","name":"Effort","category":"thought_level","type":"select","currentValue":"high","options":[{"value":"low","name":"Low"},{"value":"high","name":"High"}]},{"id":"fast","name":"Fast mode","category":"model_config","type":"select","currentValue":"on","options":[{"value":"on","name":"On"},{"value":"off","name":"Off"}]}]}"#;
    let r3 = format!(r#"{{"jsonrpc":"2.0","id":3,"result":{after}}}"#);
    let r4 = format!(r#"{{"jsonrpc":"2.0","id":4,"result":{after}}}"#);
    let r5 = format!(r#"{{"jsonrpc":"2.0","id":5,"result":{after}}}"#);
    let ok = part("m1", "ok");
    let reader = transcript_for(
        SESSION_WITH_CONFIG_OPTION,
        &[&r3, &r4, &r5, &ok],
        6,
        "end_turn",
    );
    let config = BTreeMap::from([
        ("effort".into(), "high".into()),
        ("fast".into(), "on".into()),
        // Stale key the session does not advertise — must be skipped.
        ("nonexistent".into(), "x".into()),
    ]);
    let text = run_session(
        reader,
        &mut sent,
        Turn {
            cwd: &PathBuf::from("/repo"),
            model: "haiku",
            config: &config,
            text: "describe this",
            launch_pinned: false,
            progress: &|_| {},
        },
    )
    .unwrap();
    assert_eq!(text, "ok");
    assert_eq!(
        requests(&sent),
        [
            (1, "initialize".into()),
            (2, "session/new".into()),
            (3, "session/set_config_option".into()),
            (4, "session/set_config_option".into()),
            (5, "session/set_config_option".into()),
            (6, "session/prompt".into()),
        ]
    );
    assert_eq!(request_params(&sent, 3)["configId"], "model");
    assert_eq!(request_params(&sent, 3)["value"], "haiku");
    // BTreeMap iterates keys in order: effort, then fast (nonexistent skipped).
    assert_eq!(request_params(&sent, 4)["configId"], "effort");
    assert_eq!(request_params(&sent, 4)["value"], "high");
    assert_eq!(request_params(&sent, 5)["configId"], "fast");
    assert_eq!(request_params(&sent, 5)["value"], "on");
}

#[test]
fn probe_surfaces_thought_level_and_model_config_options() {
    let reader = transcript_for(SESSION_WITH_CONFIG_OPTION, &[], 4, "end_turn");
    let probe = probe_session(reader, &mut Vec::new(), &PathBuf::from("/repo")).unwrap();
    assert_eq!(probe.models.len(), 2);
    assert_eq!(probe.current_model_id, "opus[1m]");
    assert_eq!(
        probe
            .config_options
            .iter()
            .map(|o| (o.id.as_str(), o.category.as_str()))
            .collect::<Vec<_>>(),
        [("effort", "thought_level"), ("fast", "model_config")]
    );
    // Mode is a session-permission concern — Settings does not list it.
    assert!(probe.config_options.iter().all(|o| o.id != "mode"));
}

#[test]
fn probe_prefers_config_option_models_over_available_models() {
    // Codex advertises both: the effort cartesian product in
    // availableModels, and the base list in configOptions. Preferring the
    // former made Settings show "Sol (low)/(medium)/…" *and* a separate
    // Reasoning effort control.
    let reader = transcript_for(SESSION_WITH_BOTH, &[], 3, "end_turn");
    let probe = probe_session(reader, &mut Vec::new(), &PathBuf::from("/repo")).unwrap();
    assert_eq!(
        probe
            .models
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        ["gpt-5.6-sol", "gpt-5.6-luna"]
    );
    assert_eq!(probe.current_model_id, "gpt-5.6-luna");
    assert!(probe
        .config_options
        .iter()
        .any(|o| o.id == "reasoning_effort"));
}

#[test]
fn splits_a_legacy_effort_suffix_when_pinning_via_config_option() {
    // An agent saved under the old availableModels list still carries
    // `gpt-5.6-sol[low]`. The config-option model list only has the base
    // id, so the pin is split into model + reasoning_effort.
    let mut sent = Vec::new();
    let after = r#"{"configOptions":[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"gpt-5.6-sol","options":[{"value":"gpt-5.6-sol","name":"GPT-5.6-Sol"},{"value":"gpt-5.6-luna","name":"GPT-5.6-Luna"}]},{"id":"reasoning_effort","name":"Reasoning effort","category":"thought_level","type":"select","currentValue":"low","options":[{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"}]},{"id":"fast-mode","name":"Fast mode","category":"model_config","type":"select","currentValue":"off","options":[{"value":"off","name":"Off"},{"value":"on","name":"On"}]}]}"#;
    let r3 = format!(r#"{{"jsonrpc":"2.0","id":3,"result":{after}}}"#);
    let r4 = format!(r#"{{"jsonrpc":"2.0","id":4,"result":{after}}}"#);
    let ok = part("m1", "ok");
    let reader = transcript_for(SESSION_WITH_BOTH, &[&r3, &r4, &ok], 5, "end_turn");
    let text = run_session(
        reader,
        &mut sent,
        Turn {
            cwd: &PathBuf::from("/repo"),
            model: "gpt-5.6-sol[low]",
            config: &BTreeMap::new(),
            text: "describe this",
            launch_pinned: false,
            progress: &|_| {},
        },
    )
    .unwrap();
    assert_eq!(text, "ok");
    assert_eq!(
        requests(&sent),
        [
            (1, "initialize".into()),
            (2, "session/new".into()),
            (3, "session/set_config_option".into()),
            (4, "session/set_config_option".into()),
            (5, "session/prompt".into()),
        ]
    );
    assert_eq!(request_params(&sent, 3)["configId"], "model");
    assert_eq!(request_params(&sent, 3)["value"], "gpt-5.6-sol");
    assert_eq!(request_params(&sent, 4)["configId"], "reasoning_effort");
    assert_eq!(request_params(&sent, 4)["value"], "low");
}

#[test]
fn refuses_a_model_pin_an_adapter_cannot_honour() {
    // Neither mechanism advertised: answering on the default model instead
    // would silently ignore the pin.
    let error = run_session(
        transcript_for(r#"{"sessionId":"sess_1"}"#, &[], 4, "end_turn"),
        &mut Vec::new(),
        Turn {
            cwd: &PathBuf::from("/repo"),
            model: "some-model",
            config: &BTreeMap::new(),
            text: "describe this",
            launch_pinned: false,
            progress: &|_| {},
        },
    )
    .unwrap_err();
    assert!(error.contains("offers no model selection"), "{error}");
}

#[test]
fn fails_loudly_when_the_pinned_model_is_rejected() {
    let reader = transcript_for(
        SESSION_WITH_MODELS,
        &[r#"{"jsonrpc":"2.0","id":3,"error":{"code":-32602,"message":"unknown model"}}"#],
        4,
        "end_turn",
    );
    let error = run_session(
        reader,
        &mut Vec::new(),
        Turn {
            cwd: &PathBuf::from("/repo"),
            model: "gpt-9",
            config: &BTreeMap::new(),
            text: "describe this",
            launch_pinned: false,
            progress: &|_| {},
        },
    )
    .unwrap_err();
    // Answering on the default model instead would make the agent's own
    // "5.6 sol light" label a lie.
    assert!(
        error.contains("Could not select the model `gpt-9`"),
        "{error}"
    );
    assert!(error.contains("unknown model"), "{error}");
}

#[test]
fn refreshes_dependent_config_options_after_model_pin() {
    // After model changes, the adapter returns a new effort list. Pins must
    // validate against that response, not the original session/new snapshot.
    let mut sent = Vec::new();
    let after_model = r#"{"jsonrpc":"2.0","id":3,"result":{"configOptions":[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"haiku","options":[{"value":"opus[1m]","name":"Opus"},{"value":"haiku","name":"Haiku"}]},{"id":"effort","name":"Effort","category":"thought_level","type":"select","currentValue":"medium","options":[{"value":"low","name":"Low"},{"value":"xhigh","name":"Extra high"}]}]}}"#;
    let after_effort = r#"{"jsonrpc":"2.0","id":4,"result":{"configOptions":[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"haiku","options":[{"value":"haiku","name":"Haiku"}]},{"id":"effort","name":"Effort","category":"thought_level","type":"select","currentValue":"xhigh","options":[{"value":"low","name":"Low"},{"value":"xhigh","name":"Extra high"}]}]}}"#;
    // session/new has no effort option — only the post-model response adds it.
    let session = r#"{"sessionId":"sess_1","configOptions":[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"opus[1m]","options":[{"value":"opus[1m]","name":"Opus"},{"value":"haiku","name":"Haiku"}]}]}"#;
    let reader = transcript_for(
        session,
        &[after_model, after_effort, &part("m1", "ok")],
        5,
        "end_turn",
    );
    let config = BTreeMap::from([("effort".into(), "xhigh".into())]);
    let text = run_session(
        reader,
        &mut sent,
        Turn {
            cwd: &PathBuf::from("/repo"),
            model: "haiku",
            config: &config,
            text: "describe this",
            launch_pinned: false,
            progress: &|_| {},
        },
    )
    .unwrap();
    assert_eq!(text, "ok");
    assert_eq!(request_params(&sent, 3)["configId"], "model");
    assert_eq!(request_params(&sent, 4)["configId"], "effort");
    assert_eq!(request_params(&sent, 4)["value"], "xhigh");
}

#[test]
fn skips_set_model_when_a_cursor_cli_id_was_launch_pinned() {
    // CLI ids like `cursor-grok-4.5-low` are not in the ACP session list
    // (`grok-4.5[effort=high,fast=true]`). The launch `--model` flag already
    // applied the pin — calling set_model would fail.
    let mut sent = Vec::new();
    let reader = transcript_for(
        r#"{"sessionId":"sess_1","models":{"availableModels":[{"modelId":"grok-4.5[effort=high,fast=true]","name":"grok-4.5"}],"currentModelId":"grok-4.5[effort=high,fast=true]"}}"#,
        &[&chunk("ok")],
        3,
        "end_turn",
    );
    let text = run_session(
        reader,
        &mut sent,
        Turn {
            cwd: &PathBuf::from("/repo"),
            model: "cursor-grok-4.5-low",
            config: &BTreeMap::new(),
            text: "describe this",
            launch_pinned: true,
            progress: &|_| {},
        },
    )
    .unwrap();
    assert_eq!(text, "ok");
    assert_eq!(
        requests(&sent),
        [
            (1, "initialize".into()),
            (2, "session/new".into()),
            (3, "session/prompt".into()),
        ]
    );
}
