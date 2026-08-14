//! Shared fixtures for the `acp::session` tests: canned adapter transcripts and
//! the helpers that read back what we wrote to the agent.
#![allow(unused_imports)]

// Re-exported so each domain file gets the whole fixture surface — production
// entry points included — from one `use super::support::*;`.
pub(super) use super::super::permission::is_read_only_git;
pub(super) use super::super::updates::await_result;
pub(super) use super::super::*;
pub(super) use crate::acp::MAX_FRAME_BYTES;
pub(super) use serde_json::{json, Value};
pub(super) use std::collections::BTreeMap;
pub(super) use std::io::Cursor;
pub(super) use std::path::PathBuf;

/// Replies to our fixed request ids (1 = initialize, 2 = session/new,
/// then optional set_model / set_config_option, then session/prompt), plus
/// whatever notifications the case needs. Default `prompt_id` is 3 (no
/// pins); pin tests pass a higher id via [`transcript_for`].
pub(super) fn transcript(extra: &[&str], stop: &str) -> Cursor<String> {
    transcript_for(SESSION_WITH_MODELS, extra, 3, stop)
}

/// A `session/new` result advertising the `models.availableModels` shape
/// only (legacy adapters with no model config option).
pub(super) const SESSION_WITH_MODELS: &str = r#"{"sessionId":"sess_1","models":{"availableModels":[{"modelId":"gpt-5.6-sol[low]","name":"Sol"}],"currentModelId":"gpt-5.6-luna[medium]"}}"#;
/// The other shape: a `model` session config option (claude-agent-acp,
/// opencode, kimi), plus `thought_level` / `model_config` for Settings.
pub(super) const SESSION_WITH_CONFIG_OPTION: &str = r#"{"sessionId":"sess_1","configOptions":[{"id":"mode","category":"mode","currentValue":"auto","options":[]},{"id":"model","name":"Model","category":"model","type":"select","currentValue":"opus[1m]","options":[{"value":"opus[1m]","name":"Opus"},{"value":"haiku","name":"Haiku","description":"Fast"}]},{"id":"effort","name":"Effort","category":"thought_level","type":"select","currentValue":"medium","options":[{"value":"low","name":"Low"},{"value":"high","name":"High"}]},{"id":"fast","name":"Fast mode","category":"model_config","type":"select","currentValue":"off","options":[{"value":"on","name":"On"},{"value":"off","name":"Off"}]}]}"#;
/// Modern Codex: both shapes at once. `availableModels` is the effort
/// cartesian product; `configOptions.model` is the base list that pairs
/// with a separate `reasoning_effort` selector. The probe must prefer the
/// latter so Settings does not show effort twice.
pub(super) const SESSION_WITH_BOTH: &str = r#"{"sessionId":"sess_1","models":{"availableModels":[{"modelId":"gpt-5.6-sol[low]","name":"GPT-5.6-Sol (low)"},{"modelId":"gpt-5.6-sol[medium]","name":"GPT-5.6-Sol (medium)"}],"currentModelId":"gpt-5.6-luna[medium]"},"configOptions":[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"gpt-5.6-luna","options":[{"value":"gpt-5.6-sol","name":"GPT-5.6-Sol"},{"value":"gpt-5.6-luna","name":"GPT-5.6-Luna"}]},{"id":"reasoning_effort","name":"Reasoning effort","category":"thought_level","type":"select","currentValue":"medium","options":[{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"}]},{"id":"fast-mode","name":"Fast mode","category":"model_config","type":"select","currentValue":"off","options":[{"value":"off","name":"Off"},{"value":"on","name":"On"}]}]}"#;

pub(super) fn transcript_for(
    session: &str,
    extra: &[&str],
    prompt_id: i64,
    stop: &str,
) -> Cursor<String> {
    let mut lines = vec![
        r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}"#.to_string(),
        format!(r#"{{"jsonrpc":"2.0","id":2,"result":{session}}}"#),
    ];
    lines.extend(extra.iter().map(|line| line.to_string()));
    lines.push(format!(
        r#"{{"jsonrpc":"2.0","id":{prompt_id},"result":{{"stopReason":"{stop}"}}}}"#
    ));
    Cursor::new(format!("{}\n", lines.join("\n")))
}

/// A chunk of message `id` — the grouping key real adapters send.
pub(super) fn part(id: &str, text: &str) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"sess_1","update":{{"sessionUpdate":"agent_message_chunk","messageId":"{id}","content":{{"type":"text","text":"{text}"}}}}}}}}"#
    )
}

/// A chunk with no `messageId`, as an adapter that omits it would send.
pub(super) fn chunk(text: &str) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"sess_1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"{text}"}}}}}}}}"#
    )
}

pub(super) fn run(reader: Cursor<String>, sent: &mut Vec<u8>) -> Result<String, String> {
    run_session(
        reader,
        sent,
        Turn {
            cwd: &PathBuf::from("/repo"),
            model: "",
            config: &BTreeMap::new(),
            text: "describe this",
            launch_pinned: false,
            progress: &|_| {},
        },
    )
}

pub(super) fn run_with_progress(
    reader: Cursor<String>,
    sent: &mut Vec<u8>,
) -> Result<(String, Vec<String>), String> {
    let progress = std::cell::RefCell::new(Vec::new());
    let text = run_session(
        reader,
        sent,
        Turn {
            cwd: &PathBuf::from("/repo"),
            model: "",
            config: &BTreeMap::new(),
            text: "describe this",
            launch_pinned: false,
            progress: &|message| progress.borrow_mut().push(message.to_owned()),
        },
    )?;
    Ok((text, progress.into_inner()))
}

/// Every request we sent, as `(id, method)`.
pub(super) fn requests(sent: &[u8]) -> Vec<(i64, String)> {
    String::from_utf8(sent.to_vec())
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|value| value.get("method").is_some())
        .map(|value| {
            (
                value["id"].as_i64().unwrap(),
                value["method"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

/// Our reply to the agent's own request with `id` — found by id rather than
/// by position, since the replies interleave with our three requests.
pub(super) fn reply_to(sent: Vec<u8>, id: i64) -> Value {
    String::from_utf8(sent)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find(|value| value["id"] == id && value.get("method").is_none())
        .unwrap_or_else(|| panic!("no reply sent for request {id}"))
}

pub(super) fn request_params(sent: &[u8], id: i64) -> Value {
    String::from_utf8(sent.to_vec())
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find(|value| value["id"] == id && value.get("method").is_some())
        .map(|value| value["params"].clone())
        .unwrap_or_else(|| panic!("no request with id {id}"))
}
