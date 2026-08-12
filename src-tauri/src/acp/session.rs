//! One turn of the protocol: handshake, `session/new`, the model and config
//! pins, then prompt and read updates until the turn stops.

use super::answer::{answer, Answer};
use super::progress::progress_label;
use super::wire::{is_agent_message_chunk, is_agent_thought_chunk, read_frame, request};
use super::{AcpConfigOption, AcpModel, AcpProbe, PROTOCOL_VERSION};
use super::{Turn, ALLOWED_EXECUTE_GIT, AUTO_ALLOW_TOOL_KINDS};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::Path;

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

/// Select values on a `configOptions` entry (`value` / `name` / `description`).
fn select_option_values(option: &Value) -> Vec<AcpModel> {
    let text = |value: &Value, path: &str| {
        value
            .pointer(path)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    option
        .get("options")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|entry| {
                    Some(AcpModel {
                        id: entry.get("value")?.as_str()?.to_owned(),
                        name: text(entry, "/name"),
                        description: text(entry, "/description"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The `session/new` config option that selects a model, if the adapter has one.
/// Matched on `id`/`category` because both spellings appear in the wild.
fn model_config_option(session: &Value) -> Option<&Value> {
    config_options(session).find(|option| {
        let field = |key: &str| option.get(key).and_then(Value::as_str);
        field("id") == Some("model") || field("category") == Some("model")
    })
}

/// Categories Settings should expose next to the model picker (ACP SHOULD).
const SETTINGS_CONFIG_CATEGORIES: &[&str] = &["thought_level", "model_config"];

/// `thought_level` / `model_config` select options from `session/new`.
fn session_config_options(session: &Value) -> Vec<AcpConfigOption> {
    config_options(session)
        .filter_map(|option| {
            let category = option.get("category").and_then(Value::as_str)?;
            if !SETTINGS_CONFIG_CATEGORIES.contains(&category) {
                return None;
            }
            // Only `select` options are useful here; boolean needs a capability
            // we don't advertise yet.
            if option
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("select")
                != "select"
            {
                return None;
            }
            let id = option.get("id").and_then(Value::as_str)?.to_owned();
            let options = select_option_values(option);
            if options.is_empty() {
                return None;
            }
            Some(AcpConfigOption {
                id,
                name: option
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                category: category.to_owned(),
                current_value: option
                    .get("currentValue")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                options,
            })
        })
        .collect()
}

pub(super) fn config_options(session: &Value) -> impl Iterator<Item = &Value> {
    session
        .get("configOptions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

/// A live session's config option with `id`, if present.
fn config_option_by_id<'a>(session: &'a Value, id: &str) -> Option<&'a Value> {
    config_options(session).find(|option| option.get("id").and_then(Value::as_str) == Some(id))
}

fn thought_level_option(session: &Value) -> Option<&Value> {
    config_options(session)
        .find(|option| option.get("category").and_then(Value::as_str) == Some("thought_level"))
}

/// Whether `model` appears in the session's advertised model list (config
/// option values or `models.availableModels`). Legacy `base[effort]` pins count
/// when the base alone is listed — [`split_legacy_effort_pin`] handles those.
fn model_advertised_by_session(session: &Value, model: &str) -> bool {
    if let Some(option) = model_config_option(session) {
        let values = select_option_values(option);
        if values.iter().any(|entry| entry.id == model) {
            return true;
        }
        let (base, _) = split_legacy_effort_pin(model, &values);
        if values.iter().any(|entry| entry.id == base) {
            return true;
        }
    }
    session
        .pointer("/models/availableModels")
        .and_then(Value::as_array)
        .is_some_and(|list| {
            list.iter()
                .any(|entry| entry.get("modelId").and_then(Value::as_str) == Some(model))
        })
}

/// Split a legacy pin like `gpt-5.6-sol[low]` into a base model id + effort
/// when the session's model config option only lists bare ids. Cursor-style
/// ids (`name[effort=high,fast=true]`) are left alone — those adapters keep
/// the full id in the config option list.
fn split_legacy_effort_pin(model: &str, values: &[AcpModel]) -> (String, Option<String>) {
    if values.iter().any(|entry| entry.id == model) {
        return (model.to_owned(), None);
    }
    let Some((base, rest)) = model.split_once('[') else {
        return (model.to_owned(), None);
    };
    let effort = rest.strip_suffix(']').unwrap_or(rest);
    if effort.is_empty() || effort.contains('=') || !values.iter().any(|entry| entry.id == base) {
        return (model.to_owned(), None);
    }
    (base.to_owned(), Some(effort.to_owned()))
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

/// Replace `session.configOptions` with the complete list returned by
/// `session/set_config_option`, so dependent pins (effort after model) see the
/// post-change options rather than the original `session/new` snapshot.
fn merge_config_options(session: &mut Value, result: &Value) {
    if let Some(options) = result.get("configOptions") {
        session["configOptions"] = options.clone();
    }
}

/// Pump incoming messages until the response to `id` arrives, feeding agent
/// message chunks into `answer` and replying to the agent's own requests along
/// the way. When `progress` is set (the prompt turn), tool-call titles and a
/// one-shot "Writing the answer…" update stream to the UI.
fn await_result(
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

/// Pick allow vs reject for a permission request.
///
/// The tool call's `kind` decides on its own only for the kinds that cannot
/// reach outside the repo ([`AUTO_ALLOW_TOOL_KINDS`]). `execute` additionally
/// has to name a read-only git command — the kind is the adapter's own label,
/// so trusting it alone would auto-approve any shell line it chose to send.
pub(super) fn permission_outcome(params: Option<&Value>) -> Value {
    let empty: &[Value] = &[];
    let options = params
        .and_then(|p| p.get("options"))
        .and_then(Value::as_array)
        .map(|list| list.as_slice())
        .unwrap_or(empty);
    let tool_kind = params
        .and_then(|p| p.pointer("/toolCall/kind"))
        .and_then(Value::as_str)
        .unwrap_or("other");
    let want_allow = match tool_kind {
        "execute" => params
            .and_then(|p| p.pointer("/toolCall"))
            .is_some_and(is_read_only_git),
        kind => AUTO_ALLOW_TOOL_KINDS.contains(&kind),
    };
    // Exact `allow_once` / `reject_once` before any other match: an adapter that
    // lists `allow_always` first would otherwise get a standing grant out of one
    // unattended turn.
    let pick = |once: &str, prefix: &str| {
        let by = |want: &dyn Fn(&str) -> bool| {
            options
                .iter()
                .find(|option| option.get("kind").and_then(Value::as_str).is_some_and(want))
                .and_then(|option| option.get("optionId"))
                .and_then(Value::as_str)
        };
        by(&|kind: &str| kind == once).or_else(|| by(&|kind: &str| kind.starts_with(prefix)))
    };
    match if want_allow {
        pick("allow_once", "allow")
    } else {
        pick("reject_once", "reject")
    } {
        Some(option_id) => {
            json!({ "outcome": { "outcome": "selected", "optionId": option_id } })
        }
        // No matching option — cancel rather than guess the opposite polarity.
        None => json!({ "outcome": { "outcome": "cancelled" } }),
    }
}

/// Does this `execute` tool call run one read-only git command?
///
/// The command is read out of `rawInput` (adapters put it under `command`, or
/// `args` when they pass argv), tokenized with shell rules, and matched against
/// [`ALLOWED_EXECUTE_GIT`]. Anything the shell could chain, redirect, or
/// substitute (`;`, `&&`, `|`, `>`, `` ` ``, `$(`) disqualifies the whole line —
/// `git diff && rm -rf .` must not pass on its first word. Unreadable input is a
/// no, not a shrug.
fn is_read_only_git(tool_call: &Value) -> bool {
    let raw = tool_call.pointer("/rawInput");
    let command = match raw.and_then(|input| input.get("command")) {
        Some(Value::String(line)) => line.clone(),
        Some(Value::Array(argv)) => argv
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" "),
        _ => match raw
            .and_then(|input| input.get("args"))
            .and_then(Value::as_array)
        {
            Some(argv) => argv
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" "),
            None => return false,
        },
    };
    if command.contains([';', '&', '|', '>', '<', '`', '\n']) || command.contains("$(") {
        return false;
    }
    let Ok(tokens) = shell_words::split(&command) else {
        return false;
    };
    let mut tokens = tokens.iter().map(String::as_str);
    if tokens.next().map(program_name) != Some("git") {
        return false;
    }
    let tokens = tokens;
    // `git -c foo=bar diff` and `git --no-pager log` are still reads; the
    // subcommand is the first token that isn't a leading global flag or its
    // value. `-c` is the only global that takes a separate argument.
    let mut subcommand = None;
    for token in tokens {
        if token == "-c" || token == "-C" || token == "--git-dir" || token == "--work-tree" {
            // A repo-redirecting global points the read somewhere else entirely.
            return false;
        }
        if token.starts_with('-') {
            continue;
        }
        subcommand = Some(token);
        break;
    }
    subcommand.is_some_and(|name| ALLOWED_EXECUTE_GIT.contains(&name))
}

/// `/usr/bin/git` and `git.exe` are both `git`.
fn program_name(path: &str) -> &str {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    name.strip_suffix(".exe").unwrap_or(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::MAX_FRAME_BYTES;
    use std::collections::BTreeMap;
    use std::io::Cursor;
    use std::path::PathBuf;

    /// Replies to our fixed request ids (1 = initialize, 2 = session/new,
    /// then optional set_model / set_config_option, then session/prompt), plus
    /// whatever notifications the case needs. Default `prompt_id` is 3 (no
    /// pins); pin tests pass a higher id via [`transcript_for`].
    fn transcript(extra: &[&str], stop: &str) -> Cursor<String> {
        transcript_for(SESSION_WITH_MODELS, extra, 3, stop)
    }

    /// A `session/new` result advertising the `models.availableModels` shape
    /// only (legacy adapters with no model config option).
    const SESSION_WITH_MODELS: &str = r#"{"sessionId":"sess_1","models":{"availableModels":[{"modelId":"gpt-5.6-sol[low]","name":"Sol"}],"currentModelId":"gpt-5.6-luna[medium]"}}"#;
    /// The other shape: a `model` session config option (claude-agent-acp,
    /// opencode, kimi), plus `thought_level` / `model_config` for Settings.
    const SESSION_WITH_CONFIG_OPTION: &str = r#"{"sessionId":"sess_1","configOptions":[{"id":"mode","category":"mode","currentValue":"auto","options":[]},{"id":"model","name":"Model","category":"model","type":"select","currentValue":"opus[1m]","options":[{"value":"opus[1m]","name":"Opus"},{"value":"haiku","name":"Haiku","description":"Fast"}]},{"id":"effort","name":"Effort","category":"thought_level","type":"select","currentValue":"medium","options":[{"value":"low","name":"Low"},{"value":"high","name":"High"}]},{"id":"fast","name":"Fast mode","category":"model_config","type":"select","currentValue":"off","options":[{"value":"on","name":"On"},{"value":"off","name":"Off"}]}]}"#;
    /// Modern Codex: both shapes at once. `availableModels` is the effort
    /// cartesian product; `configOptions.model` is the base list that pairs
    /// with a separate `reasoning_effort` selector. The probe must prefer the
    /// latter so Settings does not show effort twice.
    const SESSION_WITH_BOTH: &str = r#"{"sessionId":"sess_1","models":{"availableModels":[{"modelId":"gpt-5.6-sol[low]","name":"GPT-5.6-Sol (low)"},{"modelId":"gpt-5.6-sol[medium]","name":"GPT-5.6-Sol (medium)"}],"currentModelId":"gpt-5.6-luna[medium]"},"configOptions":[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"gpt-5.6-luna","options":[{"value":"gpt-5.6-sol","name":"GPT-5.6-Sol"},{"value":"gpt-5.6-luna","name":"GPT-5.6-Luna"}]},{"id":"reasoning_effort","name":"Reasoning effort","category":"thought_level","type":"select","currentValue":"medium","options":[{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"}]},{"id":"fast-mode","name":"Fast mode","category":"model_config","type":"select","currentValue":"off","options":[{"value":"off","name":"Off"},{"value":"on","name":"On"}]}]}"#;

    fn transcript_for(session: &str, extra: &[&str], prompt_id: i64, stop: &str) -> Cursor<String> {
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
    fn part(id: &str, text: &str) -> String {
        format!(
            r#"{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"sess_1","update":{{"sessionUpdate":"agent_message_chunk","messageId":"{id}","content":{{"type":"text","text":"{text}"}}}}}}}}"#
        )
    }

    /// A chunk with no `messageId`, as an adapter that omits it would send.
    fn chunk(text: &str) -> String {
        format!(
            r#"{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"sess_1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"{text}"}}}}}}}}"#
        )
    }

    fn run(reader: Cursor<String>, sent: &mut Vec<u8>) -> Result<String, String> {
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

    fn run_with_progress(
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
    fn requests(sent: &[u8]) -> Vec<(i64, String)> {
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
    fn reply_to(sent: Vec<u8>, id: i64) -> Value {
        String::from_utf8(sent)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .find(|value| value["id"] == id && value.get("method").is_none())
            .unwrap_or_else(|| panic!("no reply sent for request {id}"))
    }

    fn request_params(sent: &[u8], id: i64) -> Value {
        String::from_utf8(sent.to_vec())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .find(|value| value["id"] == id && value.get("method").is_some())
            .map(|value| value["params"].clone())
            .unwrap_or_else(|| panic!("no request with id {id}"))
    }

    #[test]
    fn joins_one_message_and_ignores_other_updates() {
        let thought = r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"hmm"}}}}"#;
        let tool = r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"c1","status":"pending"}}}"#;
        let mut sent = Vec::new();
        let text = run(
            transcript(
                &[&part("m1", "Adds "), thought, tool, &part("m1", "a spike.")],
                "end_turn",
            ),
            &mut sent,
        )
        .unwrap();
        assert_eq!(text, "Adds a spike.");
        // With no model pinned, set_model is skipped entirely — prompt is id 3.
        assert_eq!(
            requests(&sent),
            [
                (1, "initialize".into()),
                (2, "session/new".into()),
                (3, "session/prompt".into()),
            ]
        );
    }

    #[test]
    fn announces_thinking_once_when_an_adapter_streams_thoughts() {
        // OpenCode can sit on thoughts with no tool titles; one Thinking…
        // label is enough to show the turn is alive.
        let thought = r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"hmm"}}}}"#;
        let thought2 = r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":" more"}}}}"#;
        let mut sent = Vec::new();
        let (text, progress) = run_with_progress(
            transcript(&[thought, thought2, &part("m1", "feat: done")], "end_turn"),
            &mut sent,
        )
        .unwrap();
        assert_eq!(text, "feat: done");
        assert_eq!(
            progress.iter().filter(|p| *p == "Thinking…").count(),
            1,
            "{progress:?}"
        );
    }

    #[test]
    fn streams_tool_titles_and_writing_progress() {
        // The waiting UI needs more than a spinner: tool titles prove the agent
        // is working, and the first message chunk flips to "Writing…".
        let tool = r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"c1","title":"Reading staged diff","kind":"execute","status":"pending"}}}"#;
        let kind_only = r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"c2","kind":"search","status":"in_progress"}}}"#;
        let mut sent = Vec::new();
        let (text, progress) = run_with_progress(
            transcript(&[tool, kind_only, &part("m1", "feat: done")], "end_turn"),
            &mut sent,
        )
        .unwrap();
        assert_eq!(text, "feat: done");
        assert!(
            progress.iter().any(|p| p == "Reading staged diff"),
            "{progress:?}"
        );
        assert!(progress.iter().any(|p| p == "Searching…"), "{progress:?}");
        assert!(
            progress.iter().any(|p| p == "Writing the answer…"),
            "{progress:?}"
        );
        // Thought-style spam must not thrash the banner; writing is one-shot.
        assert_eq!(
            progress
                .iter()
                .filter(|p| *p == "Writing the answer…")
                .count(),
            1
        );
    }

    #[test]
    fn keeps_only_the_final_message_so_narration_is_dropped() {
        // Exactly what both shipped adapters send: a preamble message, then the
        // answer as a separate message. Concatenating them put "…only the commit
        // message.feat: …" in the commit box.
        let text = run(
            transcript(
                &[
                    &part("m1", "I’ll read the staged diff exactly once"),
                    &part("m1", " and draft only the commit message."),
                    &part("m2", "feat: increase timeout"),
                    &part("m2", " and add retries"),
                ],
                "end_turn",
            ),
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(text, "feat: increase timeout and add retries");
    }

    #[test]
    fn unwraps_the_code_fence_agents_answer_in() {
        // codex-acp fences with a language tag, claude-agent-acp with a bare
        // fence; both would otherwise land verbatim in the commit box.
        let tagged = run(
            transcript(
                &[&part("m1", "```text\\nfeat: tagged fence\\n```")],
                "end_turn",
            ),
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(tagged, "feat: tagged fence");
        let bare = run(
            transcript(
                &[&part(
                    "m1",
                    "```\\nfeat: bare fence\\n\\nWith a body.\\n```",
                )],
                "end_turn",
            ),
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(bare, "feat: bare fence\n\nWith a body.");
    }

    #[test]
    fn leaves_an_unfenced_answer_and_an_inner_fence_alone() {
        let plain = run(
            transcript(&[&part("m1", "feat: plain\\n\\nA body.")], "end_turn"),
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(plain, "feat: plain\n\nA body.");
        // A body that quotes code is not "one fenced block" — unwrapping it
        // would eat the subject line.
        let quoting = run(
            transcript(
                &[&part("m1", "fix: escape backticks\\n\\n```\\ncode\\n```")],
                "end_turn",
            ),
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(quoting, "fix: escape backticks\n\n```\ncode\n```");
    }

    #[test]
    fn falls_back_to_concatenation_without_message_ids() {
        // An adapter that omits `messageId` keeps the old behaviour rather than
        // losing the answer entirely.
        let text = run(
            transcript(&[&chunk("feat: "), &chunk("no ids here")], "end_turn"),
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(text, "feat: no ids here");
    }

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
    fn rejects_an_oversized_jsonrpc_frame() {
        let oversized = format!("{}\n", "x".repeat(MAX_FRAME_BYTES + 1));
        let error = await_result(
            &mut oversized.as_bytes(),
            &mut Vec::new(),
            1,
            &mut Answer::default(),
            None,
        )
        .unwrap_err();
        assert!(error.contains(&MAX_FRAME_BYTES.to_string()), "{error}");
    }

    #[test]
    fn auto_allows_read_tool_permissions() {
        let ask = r#"{"jsonrpc":"2.0","id":77,"method":"session/request_permission","params":{"sessionId":"sess_1","toolCall":{"toolCallId":"c1","kind":"read"},"options":[{"optionId":"reject-once","name":"Reject","kind":"reject_once"},{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}"#;
        let mut sent = Vec::new();
        let text = run(transcript(&[ask, &chunk("done")], "end_turn"), &mut sent).unwrap();
        assert_eq!(text, "done");
        let reply = reply_to(sent, 77);
        assert_eq!(reply["result"]["outcome"]["outcome"], "selected");
        assert_eq!(reply["result"]["outcome"]["optionId"], "allow-once");
    }

    /// `execute` is the kind the shipped instructions need (`git diff --staged`)
    /// and also the kind that can run anything, so the command decides — not the
    /// label the adapter put on it.
    #[test]
    fn allows_only_read_only_git_for_execute_tools() {
        let allowed = [
            "git diff --staged",
            "git --no-pager log -5",
            "/usr/bin/git show HEAD",
            "git status --porcelain",
        ];
        for command in allowed {
            assert!(
                is_read_only_git(&json!({ "kind": "execute", "rawInput": { "command": command } })),
                "should allow {command}"
            );
        }
        let rejected = [
            "git commit -m x",
            "git add .",
            "git diff --staged && rm -rf .",
            "git diff; curl evil.example",
            "git diff | tee /tmp/leak",
            "git -C /somewhere/else diff",
            "git -c core.pager=sh log",
            "rm -rf /",
            "echo $(git diff)",
        ];
        for command in rejected {
            assert!(
                !is_read_only_git(
                    &json!({ "kind": "execute", "rawInput": { "command": command } })
                ),
                "should reject {command}"
            );
        }
        // argv form, and a call whose input we cannot read at all.
        assert!(is_read_only_git(
            &json!({ "rawInput": { "command": ["git", "diff", "--staged"] } })
        ));
        assert!(!is_read_only_git(&json!({ "kind": "execute" })));
    }

    #[test]
    fn rejects_an_execute_tool_whose_command_is_not_a_git_read() {
        let ask = r#"{"jsonrpc":"2.0","id":81,"method":"session/request_permission","params":{"sessionId":"sess_1","toolCall":{"toolCallId":"c1","kind":"execute","rawInput":{"command":"rm -rf ."}},"options":[{"optionId":"reject-once","name":"Reject","kind":"reject_once"},{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}"#;
        let mut sent = Vec::new();
        run(transcript(&[ask, &chunk("ok")], "end_turn"), &mut sent).unwrap();
        assert_eq!(
            reply_to(sent, 81)["result"]["outcome"]["optionId"],
            "reject-once"
        );
    }

    /// A turn GitLane started unattended must never hand out a standing grant.
    #[test]
    fn prefers_allow_once_over_allow_always() {
        let ask = r#"{"jsonrpc":"2.0","id":82,"method":"session/request_permission","params":{"sessionId":"sess_1","toolCall":{"toolCallId":"c1","kind":"read"},"options":[{"optionId":"allow-always","name":"Always allow","kind":"allow_always"},{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}"#;
        let mut sent = Vec::new();
        run(transcript(&[ask, &chunk("ok")], "end_turn"), &mut sent).unwrap();
        assert_eq!(
            reply_to(sent, 82)["result"]["outcome"]["optionId"],
            "allow-once"
        );
    }

    #[test]
    fn rejects_network_fetch_tools() {
        let ask = r#"{"jsonrpc":"2.0","id":83,"method":"session/request_permission","params":{"sessionId":"sess_1","toolCall":{"toolCallId":"c1","kind":"fetch"},"options":[{"optionId":"reject-once","name":"Reject","kind":"reject_once"},{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}"#;
        let mut sent = Vec::new();
        run(transcript(&[ask, &chunk("ok")], "end_turn"), &mut sent).unwrap();
        assert_eq!(
            reply_to(sent, 83)["result"]["outcome"]["optionId"],
            "reject-once"
        );
    }

    #[test]
    fn rejects_write_tool_permissions() {
        let ask = r#"{"jsonrpc":"2.0","id":79,"method":"session/request_permission","params":{"sessionId":"sess_1","toolCall":{"toolCallId":"c1","kind":"edit"},"options":[{"optionId":"reject-once","name":"Reject","kind":"reject_once"},{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}"#;
        let mut sent = Vec::new();
        run(transcript(&[ask, &chunk("ok")], "end_turn"), &mut sent).unwrap();
        let reply = reply_to(sent, 79);
        assert_eq!(reply["result"]["outcome"]["outcome"], "selected");
        assert_eq!(reply["result"]["outcome"]["optionId"], "reject-once");
    }

    #[test]
    fn cancels_a_permission_request_that_offers_no_matching_option() {
        // Write tool, but the agent only offered allow options — cancel rather
        // than auto-approving a write.
        let ask = r#"{"jsonrpc":"2.0","id":78,"method":"session/request_permission","params":{"toolCall":{"toolCallId":"c1","kind":"edit"},"options":[{"optionId":"yes","name":"Allow","kind":"allow_once"}]}}"#;
        let mut sent = Vec::new();
        run(transcript(&[ask, &chunk("ok")], "end_turn"), &mut sent).unwrap();
        assert_eq!(
            reply_to(sent, 78)["result"]["outcome"]["outcome"],
            "cancelled"
        );
    }

    #[test]
    fn refuses_unsupported_requests_instead_of_hanging() {
        let ask = r#"{"jsonrpc":"2.0","id":90,"method":"fs/write_text_file","params":{"path":"/repo/x"}}"#;
        let mut sent = Vec::new();
        run(transcript(&[ask, &chunk("ok")], "end_turn"), &mut sent).unwrap();
        assert_eq!(reply_to(sent, 90)["error"]["code"], -32601);
    }

    #[test]
    fn reports_a_refusal_and_a_silent_turn_distinctly() {
        assert_eq!(
            run(transcript(&[], "refusal"), &mut Vec::new()).unwrap_err(),
            "The agent declined to answer."
        );
        assert_eq!(
            run(transcript(&[], "end_turn"), &mut Vec::new()).unwrap_err(),
            "The agent returned no text."
        );
    }

    #[test]
    fn surfaces_a_protocol_error_response() {
        let reader = Cursor::new(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"auth required\"}}\n"
                .to_string(),
        );
        assert_eq!(
            run(reader, &mut Vec::new()).unwrap_err(),
            "The agent reported an error: auth required"
        );
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

    #[test]
    fn tolerates_noise_and_a_truncated_stream() {
        // A banner line and a blank line must not derail the conversation.
        let reader = Cursor::new(format!(
            "warming up\n\n{}\n",
            r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}"#
        ));
        // …but a stream that ends before the answer is an error, not an empty
        // success (the mailbox flow's silent-timeout failure mode).
        assert_eq!(
            run(reader, &mut Vec::new()).unwrap_err(),
            "The agent exited before answering."
        );
    }
}
