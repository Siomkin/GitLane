//! Answering `session/request_permission`: which tool calls run unattended,
//! and which read-only git commands an `execute` call may name.

use super::super::{ALLOWED_EXECUTE_GIT, AUTO_ALLOW_TOOL_KINDS};
use serde_json::{json, Value};

/// Pick allow vs reject for a permission request.
///
/// The tool call's `kind` decides on its own only for the kinds that cannot
/// reach outside the repo ([`AUTO_ALLOW_TOOL_KINDS`]). `execute` additionally
/// has to name a read-only git command — the kind is the adapter's own label,
/// so trusting it alone would auto-approve any shell line it chose to send.
pub(in crate::acp) fn permission_outcome(params: Option<&Value>) -> Value {
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
pub(super) fn is_read_only_git(tool_call: &Value) -> bool {
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
