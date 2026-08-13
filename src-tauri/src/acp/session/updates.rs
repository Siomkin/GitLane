//! The read loop: pump incoming frames until the response we are waiting for
//! arrives, answering the agent's own requests on the way.

use super::super::answer::{answer, Answer};
use super::super::progress::progress_label;
use super::super::wire::{
    is_agent_message_chunk, is_agent_thought_chunk, is_tool_call, read_frame,
};
use serde_json::Value;
use std::io::{BufRead, Write};

/// Pump incoming messages until the response to `id` arrives, feeding agent
/// message chunks into `answer` and replying to the agent's own requests along
/// the way. When `progress` is set (the prompt turn), tool-call titles and a
/// one-shot "Writing the answer…" update stream to the UI.
pub(super) fn await_result(
    reader: &mut impl BufRead,
    writer: &mut impl Write,
    id: i64,
    answer_text: &mut Answer,
    progress: Option<&dyn Fn(&str)>,
) -> Result<Value, String> {
    let mut announced_writing = false;
    let mut announced_thinking = false;
    loop {
        let Some(line) = read_frame(reader)? else {
            return Err("The agent exited before answering.".into());
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            // A stray non-JSON line (a banner, a warning) is not fatal.
            continue;
        };
        match (value.get("method").and_then(Value::as_str), value.get("id")) {
            // A notification: message text builds the answer; other updates may
            // carry a progress label for the waiting UI.
            (Some("session/update"), None) => {
                let is_message = is_agent_message_chunk(&value);
                let is_thought = is_agent_thought_chunk(&value);
                if is_tool_call(&value) {
                    answer_text.discard_preamble();
                }
                answer_text.push(&value);
                if let Some(progress) = progress {
                    if let Some(label) = progress_label(&value) {
                        progress(&label);
                    } else if is_message && !announced_writing {
                        announced_writing = true;
                        progress("Writing the answer…");
                    } else if is_thought && !announced_thinking && !announced_writing {
                        // OpenCode (and others) can think for a long time with
                        // no tool titles — one "Thinking…" beats a frozen
                        // "Sending the prompt…".
                        announced_thinking = true;
                        progress("Thinking…");
                    }
                }
            }
            (Some(_), None) => {}
            // A request from the agent — every one must be answered or the
            // agent blocks forever waiting on us.
            (Some(method), Some(request_id)) => {
                answer(writer, method, request_id.clone(), value.get("params"))?
            }
            // A response to one of ours.
            (None, Some(response_id)) => {
                if response_id.as_i64() != Some(id) {
                    continue;
                }
                if let Some(error) = value.get("error") {
                    let text = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error");
                    return Err(format!("The agent reported an error: {text}"));
                }
                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
            }
            (None, None) => {}
        }
    }
}
