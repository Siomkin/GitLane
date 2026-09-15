//! Answering `session/request_permission`: which tool calls run unattended,
//! and which read-only git commands an `execute` call may name.

use super::super::{ALLOWED_EXECUTE_GIT, AUTO_ALLOW_TOOL_KINDS};
use serde_json::{json, Value};
use std::path::Path;

/// Pick allow vs reject for a permission request.
///
/// The tool call's `kind` decides on its own only for the kinds that cannot
/// reach outside the repo ([`AUTO_ALLOW_TOOL_KINDS`]). `execute` additionally
/// has to name a read-only git command run in the session's own `cwd` — the
/// kind is the adapter's own label, so trusting it alone would auto-approve
/// any shell line it chose to send.
pub(in crate::acp) fn permission_outcome(params: Option<&Value>, cwd: &Path) -> Value {
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
            .is_some_and(|call| stays_in_cwd(call, cwd) && is_read_only_git(call)),
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

/// Keys adapters use for the directory an `execute` call runs in (Codex sends
/// `workdir`, Gemini `dir_path`). The adapter honours that field when it spawns
/// the command, so a value other than the session cwd redirects a "read" as
/// surely as `--git-dir` would.
const WORKDIR_KEYS: &[&str] = &[
    "cwd",
    "workdir",
    "dir_path",
    "directory",
    "working_directory",
];

/// Leading globals that change only how output is presented or locked, never
/// where git reads. Everything else before the subcommand is rejected — git has
/// too many repo-redirecting globals (`--git-dir=`, `--work-tree=`,
/// `--config-env=`, `--exec-path=`, `-C`, `-c`, …) to enumerate safely.
const HARMLESS_GLOBALS: &[&str] = &["--no-pager", "--no-optional-locks"];

/// Does the call's working directory (if it names one) equal the session cwd?
/// A missing or empty field means the adapter runs in the session cwd.
fn stays_in_cwd(tool_call: &Value, cwd: &Path) -> bool {
    let Some(input) = tool_call.get("rawInput") else {
        return true;
    };
    WORKDIR_KEYS.iter().all(|key| match input.get(key) {
        None | Some(Value::Null) => true,
        Some(Value::String(dir)) => {
            let dir = dir.trim();
            if dir.is_empty() {
                return true;
            }
            // `join` keeps an absolute value and resolves a relative one against
            // the cwd. Adapters report their *resolved* directory, so compare
            // canonical paths (symlinks such as macOS `/tmp`, Windows casing);
            // fall back to lexical equality when either does not resolve.
            let claimed = cwd.join(dir);
            match (claimed.canonicalize(), cwd.canonicalize()) {
                (Ok(a), Ok(b)) => a == b,
                _ => claimed == cwd,
            }
        }
        Some(_) => false,
    })
}

/// Does this `execute` tool call run one read-only git command?
///
/// The command is read out of `rawInput` (adapters put it under `command`, or
/// `args` when they pass argv), tokenized with shell rules, and checked in
/// three parts: the program must be `git`; every global before the subcommand
/// must be in [`HARMLESS_GLOBALS`]; the subcommand must be in
/// [`ALLOWED_EXECUTE_GIT`]; and no option after it may write a file or read
/// outside the repository ([`writes_or_leaves_repo`]). Anything the shell could
/// chain, redirect, or substitute (`;`, `&&`, `|`, `>`, `` ` ``, `$(`)
/// disqualifies the whole line — `git diff && rm -rf .` must not pass on its
/// first word. Unreadable input is a no, not a shrug.
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
    // The subcommand is the first token that is not a leading global; only the
    // allowlisted globals may precede it.
    let mut subcommand = None;
    for token in tokens.by_ref() {
        if !token.starts_with('-') {
            subcommand = Some(token);
            break;
        }
        if !HARMLESS_GLOBALS.contains(&token) {
            return false;
        }
    }
    if !subcommand.is_some_and(|name| ALLOWED_EXECUTE_GIT.contains(&name)) {
        return false;
    }
    tokens.all(|token| !writes_or_leaves_repo(token))
}

/// Options of the allowed subcommands that make git write a file (`diff`/`log`/
/// `show --output`) or read one outside the repository (`diff --no-index`,
/// `blame --contents`). A targeted denylist: agents legitimately pass arbitrary
/// `--format`, `-n`, pathspecs and revisions, so an allowlist would be either
/// porous or constantly wrong.
const DENIED_OPTIONS: &[&str] = &["--output", "--no-index", "--contents"];

/// Is `token` one of [`DENIED_OPTIONS`], spelled out or abbreviated? git's
/// parse-options resolves any unambiguous prefix of a long option, so
/// `--cont=<file>` *is* `--contents=<file>`; a token whose name is a prefix of a
/// denied option is therefore denied too (fail closed on the ambiguous ones).
/// `--output-indicator-*` is longer than `--output`, not a prefix of it, and
/// still passes.
fn writes_or_leaves_repo(token: &str) -> bool {
    let name = token.split_once('=').map_or(token, |(name, _)| name);
    name.len() > 3 && DENIED_OPTIONS.iter().any(|denied| denied.starts_with(name))
}

/// `/usr/bin/git` and `git.exe` are both `git`.
fn program_name(path: &str) -> &str {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    name.strip_suffix(".exe").unwrap_or(name)
}
