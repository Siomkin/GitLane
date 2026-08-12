//! Assembling the agent's answer out of `agent_message_chunk` updates.

use super::session::permission_outcome;
use super::wire::send;
use super::MAX_ANSWER_BYTES;
use serde_json::{json, Value};
use std::io::Write;

/// The agent's answer, assembled from `agent_message_chunk` updates.
///
/// A turn is not one message. Agents narrate first — "I'll read the staged diff
/// and draft only the commit message." — and send the actual answer as a
/// *separate* message afterwards. Chunks carry a `messageId`, so a new id means
/// everything before it was preamble: keep only the last message, or the
/// commit box ends up holding the narration glued to the answer.
///
/// Chunks with no `messageId` fall back to plain concatenation. Both adapters
/// GitLane ships send one; an adapter that doesn't gets today's behaviour
/// rather than a dropped answer.
#[derive(Default)]
pub(super) struct Answer {
    id: Option<String>,
    text: String,
}

impl Answer {
    /// Take one `session/update`. Other update kinds (`agent_thought_chunk`,
    /// `tool_call`, `tool_call_update`, plan updates) carry no answer text.
    pub(super) fn push(&mut self, value: &Value) {
        let Some(update) = value.pointer("/params/update") else {
            return;
        };
        if update.get("sessionUpdate").and_then(Value::as_str) != Some("agent_message_chunk") {
            return;
        }
        let id = update.get("messageId").and_then(Value::as_str);
        if let Some(id) = id {
            if self.id.as_deref() != Some(id) {
                // A new message supersedes whatever came before it.
                self.id = Some(id.to_owned());
                self.text.clear();
            }
        }
        if let Some(text) = update.pointer("/content/text").and_then(Value::as_str) {
            // Past the cap the answer is runaway output, not an answer: keep
            // what arrived first and drop the rest.
            if self.text.len() + text.len() <= MAX_ANSWER_BYTES {
                self.text.push_str(text);
            }
        }
    }
    pub(super) fn finish(self) -> String {
        unfence(self.text.trim()).to_owned()
    }
}

/// Unwrap an answer the agent wrapped in a Markdown code fence.
///
/// Asked for a commit message, both shipped adapters reply with the message
/// inside a fence — ```` ```text ```` for codex-acp, a bare ```` ``` ```` for
/// claude-agent-acp — which would otherwise land in the commit box verbatim.
/// Only a message that is *entirely* one fenced block is unwrapped, so a body
/// that happens to quote code keeps its fences.
fn unfence(text: &str) -> &str {
    let Some(rest) = text.strip_prefix("```") else {
        return text;
    };
    let Some(body) = rest.strip_suffix("```") else {
        return text;
    };
    // Drop the opening fence's own line, which may carry a language tag.
    match body.split_once('\n') {
        Some((_lang, inner)) => inner.trim_matches('\n'),
        // A single-line ```…``` has no content worth unwrapping.
        None => text,
    }
}

/// Answer a request the agent made of us.
///
/// Draft / Describe are read-oriented: auto-allow only safe tool kinds (and
/// `execute` for `git diff --staged`). Write kinds are rejected — there is no
/// permission overlay yet, so silently approving edits would be worse than
/// cancelling the tool. A real user prompt needs a `session/update` stream.
pub(super) fn answer(
    writer: &mut impl Write,
    method: &str,
    id: Value,
    params: Option<&Value>,
) -> Result<(), String> {
    let result = match method {
        "session/request_permission" => permission_outcome(params),
        // We advertised no other client capabilities, so anything else is the
        // agent overreaching. Refuse explicitly rather than leaving it hung.
        _ => {
            return send(
                writer,
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": format!("{method} is not supported") },
                }),
            )
        }
    };
    send(
        writer,
        json!({ "jsonrpc": "2.0", "id": id, "result": result }),
    )
}
