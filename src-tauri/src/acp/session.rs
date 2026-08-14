//! One turn of the protocol: handshake, `session/new`, the model and config
//! pins, then prompt and read updates until the turn stops.
//!
//! The option/permission detail lives in the focused submodules; this file is
//! the protocol flow itself.

mod options;
mod permission;
#[cfg(test)]
mod tests;
mod updates;

use super::answer::Answer;
use super::wire::request;
use super::{AcpModel, AcpProbe, Turn, PROTOCOL_VERSION};
use options::{
    config_option_by_id, merge_config_options, model_advertised_by_session, model_config_option,
    select_option_values, session_config_options, split_legacy_effort_pin, thought_level_option,
};
pub(in crate::acp) use permission::permission_outcome;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::Path;
use updates::await_result;

/// `initialize` then `session/new`, returning both results. Every conversation
/// starts this way, so both the prompt turn and the capability probe share it.
fn handshake(
    reader: &mut impl BufRead,
    writer: &mut impl Write,
    cwd: &Path,
) -> Result<(Value, Value), String> {
    request(
        writer,
        1,
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            // No filesystem capabilities: the agent uses its own tools rather
            // than asking us to read or write on its behalf.
            "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } },
            "clientInfo": { "name": "gitlane", "version": env!("CARGO_PKG_VERSION") },
        }),
    )?;
    let hello = await_result(reader, writer, 1, &mut Answer::default(), None)?;
    request(
        writer,
        2,
        "session/new",
        json!({ "cwd": cwd, "mcpServers": [] }),
    )?;
    let session = await_result(reader, writer, 2, &mut Answer::default(), None)?;
    Ok((hello, session))
}

/// Read an adapter's identity and model list off a bare handshake — no prompt,
/// so this costs nothing but process startup and never bills a turn.
pub(super) fn probe_session(
    mut reader: impl BufRead,
    mut writer: impl Write,
    cwd: &Path,
) -> Result<AcpProbe, String> {
    let (hello, session) = handshake(&mut reader, &mut writer, cwd)?;
    let text = |value: &Value, path: &str| {
        value
            .pointer(path)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    // Two shapes carry a model list. Prefer the session *config option*
    // (`category: "model"`) when present — ACP's preferred surface, and the
    // one that pairs with a separate `thought_level` (Codex: base models in
    // configOptions, effort variants only in the legacy `availableModels`
    // cartesian product). Fall back to `models.availableModels` for adapters
    // that still only advertise that shape.
    let from_models = session
        .pointer("/models/availableModels")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|model| {
                    Some(AcpModel {
                        id: model.get("modelId")?.as_str()?.to_owned(),
                        name: text(model, "/name"),
                        description: text(model, "/description"),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let model_option = model_config_option(&session);
    let from_config = model_option.map(select_option_values).unwrap_or_default();
    let models = if from_config.is_empty() {
        from_models
    } else {
        from_config
    };
    let current = if !models.is_empty() && model_option.is_some() {
        model_option
            .and_then(|option| option.get("currentValue"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    } else if session.pointer("/models/currentModelId").is_some() {
        text(&session, "/models/currentModelId")
    } else {
        String::new()
    };
    Ok(AcpProbe {
        agent_name: text(&hello, "/agentInfo/name"),
        agent_version: text(&hello, "/agentInfo/version"),
        models,
        current_model_id: current,
        config_options: session_config_options(&session),
    })
}

/// Drive one turn: handshake, prompt, and accumulate the agent's message chunks
/// until the prompt call returns.
///
/// Split from [`prompt`] so the protocol half is testable against a canned
/// transcript with no subprocess involved.
pub(super) fn run_session(
    mut reader: impl BufRead,
    mut writer: impl Write,
    turn: Turn<'_>,
) -> Result<String, String> {
    let Turn {
        cwd,
        model,
        config,
        text,
        launch_pinned,
        progress,
    } = turn;
    progress("Starting the agent…");
    let (_, mut session) = handshake(&mut reader, &mut writer, cwd)?;
    let session_id = session
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or("The agent did not return a session id.")?
        .to_owned();
    // Request ids after handshake: model pin, then each config pin, then prompt.
    let mut next_id = 3i64;
    // Owned so a legacy `base[effort]` pin can inject the effort into the map
    // without mutating the caller's.
    let mut config = config.clone();
    // A model-pinned agent must actually run on the model its name promises.
    // Adapter CLI flags are unreliable for this — `codex-acp` honours `--model`
    // but silently drops the reasoning effort, and `claude-agent-acp` ignores
    // `--model` entirely. A failure here is fatal on purpose: quietly answering
    // on the default model would make the agent's own label a lie.
    //
    // Cursor is the exception: ACP only advertises one effort preset per model,
    // so effort variants from `--list-models` are pinned with a launch `--model`
    // flag (`launch_pinned`). Those CLI ids are not in the session list — skip
    // the protocol pin rather than failing set_model.
    if !model.is_empty() {
        let skip_protocol_pin = launch_pinned && !model_advertised_by_session(&session, model);
        if !skip_protocol_pin {
            progress(&format!("Using {model}…"));
            // Prefer `session/set_config_option` when the adapter advertises a model
            // config option (Codex, Claude, OpenCode). `session/set_model` is the
            // fallback for adapters that only expose `models.availableModels`.
            // OpenCode cannot take `-m` on `opencode acp` (CLI exits with help),
            // so this protocol pin is the only reliable way to avoid its default
            // `opencode/big-pickle` model.
            let (method, params, label) = if let Some(option) = model_config_option(&session) {
                let values = select_option_values(option);
                let (model_id, effort) = split_legacy_effort_pin(model, &values);
                if let Some(effort) = effort {
                    if let Some(thought) = thought_level_option(&session) {
                        let effort_id = thought
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("effort");
                        // An explicit Settings pin wins over a legacy suffix.
                        config.entry(effort_id.to_owned()).or_insert(effort);
                    }
                }
                let config_id = option.get("id").and_then(Value::as_str).unwrap_or("model");
                (
                    "session/set_config_option",
                    json!({ "sessionId": session_id, "configId": config_id, "value": model_id }),
                    model_id,
                )
            } else if session.pointer("/models/availableModels").is_some() {
                (
                    "session/set_model",
                    json!({ "sessionId": session_id, "modelId": model }),
                    model.to_owned(),
                )
            } else {
                return Err(format!(
                    "This agent is pinned to `{model}`, but its adapter offers no model selection."
                ));
            };
            request(&mut writer, next_id, method, params)?;
            let result = await_result(
                &mut reader,
                &mut writer,
                next_id,
                &mut Answer::default(),
                None,
            )
            .map_err(|error| format!("Could not select the model `{label}`. {error}"))?;
            // Model selection can add/remove dependent options (effort, fast).
            merge_config_options(&mut session, &result);
            next_id += 1;
        }
    }
    // Apply effort / fast / other model-adjacent pins. Stale keys (an option the
    // live session no longer advertises) are skipped — the adapter may drop
    // thought_level when the chosen model has no reasoning control. Each
    // successful set refreshes `session` so later pins see the dependent state.
    for (config_id, value) in &config {
        let value = value.trim();
        if value.is_empty() || config_option_by_id(&session, config_id).is_none() {
            continue;
        }
        request(
            &mut writer,
            next_id,
            "session/set_config_option",
            json!({ "sessionId": session_id, "configId": config_id, "value": value }),
        )?;
        let result = await_result(
            &mut reader,
            &mut writer,
            next_id,
            &mut Answer::default(),
            None,
        )
        .map_err(|error| format!("Could not set `{config_id}` to `{value}`. {error}"))?;
        merge_config_options(&mut session, &result);
        next_id += 1;
    }
    progress("Sending the prompt…");
    let mut answer = Answer::default();
    request(
        &mut writer,
        next_id,
        "session/prompt",
        json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": text }] }),
    )?;
    let turn = await_result(
        &mut reader,
        &mut writer,
        next_id,
        &mut answer,
        Some(progress),
    )?;
    let stop = turn.get("stopReason").and_then(Value::as_str).unwrap_or("");
    let message = answer.finish()?;
    if message.is_empty() {
        return Err(match stop {
            "refusal" => "The agent declined to answer.".into(),
            "cancelled" => "The agent cancelled the request.".into(),
            "max_tokens" | "max_turn_requests" => {
                format!("The agent stopped before answering ({stop}).")
            }
            _ => "The agent returned no text.".into(),
        });
    }
    Ok(message)
}
