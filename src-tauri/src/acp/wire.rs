//! The newline-delimited JSON-RPC wire: reading one bounded frame, writing a
//! request or notification, and classifying update frames.

use super::MAX_FRAME_BYTES;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

pub(super) fn is_agent_message_chunk(value: &Value) -> bool {
    value
        .pointer("/params/update/sessionUpdate")
        .and_then(Value::as_str)
        == Some("agent_message_chunk")
}

pub(super) fn is_agent_thought_chunk(value: &Value) -> bool {
    value
        .pointer("/params/update/sessionUpdate")
        .and_then(Value::as_str)
        == Some("agent_thought_chunk")
}

pub(super) fn is_tool_call(value: &Value) -> bool {
    value
        .pointer("/params/update/sessionUpdate")
        .and_then(Value::as_str)
        == Some("tool_call")
}

/// Read one newline-delimited frame, failing closed if it exceeds
/// [`MAX_FRAME_BYTES`] before a newline arrives.
pub(super) fn read_frame(reader: &mut impl BufRead) -> Result<Option<String>, String> {
    let mut buf = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .map_err(|error| format!("Could not read from the agent: {error}"))?;
        if available.is_empty() {
            return if buf.is_empty() {
                Ok(None)
            } else {
                Err("The agent exited before finishing a response.".into())
            };
        }
        if let Some(newline) = available.iter().position(|&b| b == b'\n') {
            let end = newline + 1;
            if buf.len() + end > MAX_FRAME_BYTES {
                return Err(format!(
                    "The agent sent a response larger than {MAX_FRAME_BYTES} bytes."
                ));
            }
            buf.extend_from_slice(&available[..end]);
            reader.consume(end);
            return Ok(Some(String::from_utf8_lossy(&buf).into_owned()));
        }
        if buf.len() + available.len() > MAX_FRAME_BYTES {
            return Err(format!(
                "The agent sent a response larger than {MAX_FRAME_BYTES} bytes."
            ));
        }
        let take = available.len();
        buf.extend_from_slice(available);
        reader.consume(take);
    }
}

pub(super) fn request(
    writer: &mut impl Write,
    id: i64,
    method: &str,
    params: Value,
) -> Result<(), String> {
    send(
        writer,
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
    )
}

pub(super) fn send(writer: &mut impl Write, message: Value) -> Result<(), String> {
    writeln!(writer, "{message}")
        .map_err(|error| format!("Could not write to the agent: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("Could not write to the agent: {error}"))
}
