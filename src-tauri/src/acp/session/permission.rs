//! Answering `session/request_permission`: which tool calls run unattended,
//! and which read-only git commands an `execute` call may name.

mod paths;

use super::super::{ALLOWED_EXECUTE_GIT, AUTO_ALLOW_TOOL_KINDS};
use serde_json::{Value, json};
use std::path::Path;

/// Pick allow vs reject for a permission request.
///
/// The tool call's `kind` decides on its own only for the kinds that cannot
/// reach outside the repo ([`AUTO_ALLOW_TOOL_KINDS`]). `execute` additionally
/// has to name a read-only git command run in the session's own `cwd` — the
/// kind is the adapter's own label, so trusting it alone would auto-approve
/// any shell line it chose to send. `read` and `search` are decided by the
/// paths they report ([`paths::paths_stay_in_repo`]), not by their kind.
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
            .is_some_and(|call| stays_in_cwd(call, cwd) && is_read_only_git(call, cwd)),
        kind @ ("read" | "search") => params
            .and_then(|p| p.pointer("/toolCall"))
            .is_some_and(|call| paths::paths_stay_in_repo(call, cwd, kind)),
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

/// Does this `execute` tool call run one read-only git command in `cwd`?
///
/// The command is read out of `rawInput` (adapters put it under `command`, or
/// `args` when they pass argv) and checked by [`is_read_only_argv`]. A string
/// is a shell line: before it is tokenized, [`has_shell_expansion`] refuses
/// anything a shell would expand into other arguments (globs, braces, `~`,
/// `=cmd`), so the tokens checked are the arguments git gets. An array is the
/// argv the adapter execs (no shell), so it is checked element for element —
/// joining and re-splitting it would validate a different argv
/// (`["git","log","--format='","--output=/x","--grep='"]` re-splits into one
/// quoted `--format` token while git gets `--output=/x`). Unreadable input is a
/// no, not a shrug, and so is a `command` with an `args` beside it — an adapter
/// may run both, and only one is read.
pub(super) fn is_read_only_git(tool_call: &Value, cwd: &Path) -> bool {
    let Ok(root) = cwd.canonicalize() else {
        return false;
    };
    let raw = tool_call.pointer("/rawInput");
    if raw.is_some_and(|input| input.get("command").is_some() && input.get("args").is_some()) {
        return false;
    }
    let argv = match raw.and_then(|input| input.get("command")) {
        Some(Value::String(line)) => {
            return !has_shell_metachar(line)
                && !has_shell_expansion(line)
                && shell_words::split(line).is_ok_and(|tokens| is_read_only_argv(&tokens, &root));
        }
        Some(Value::Array(argv)) => argv,
        _ => match raw
            .and_then(|input| input.get("args"))
            .and_then(Value::as_array)
        {
            Some(argv) => argv,
            None => return false,
        },
    };
    // A non-string element is unreadable input, not something to skip.
    argv.iter()
        .map(|arg| arg.as_str().map(str::to_owned))
        .collect::<Option<Vec<_>>>()
        .is_some_and(|argv| is_read_only_argv(&argv, &root))
}

/// Is `argv` one read-only git command? The program must be a bare `git` (a
/// path such as `./git` could run an executable the repository ships); every
/// global before the subcommand must be in [`HARMLESS_GLOBALS`]; the
/// subcommand must be in [`ALLOWED_EXECUTE_GIT`]; no option after it may write
/// a file or read outside the repository ([`writes_or_leaves_repo`]); and no
/// argument or option value may name a path outside the repository or inside
/// its `.git` ([`leaves_repo`]). An element holding anything the shell could
/// chain, redirect, or substitute (`;`, `&&`, `|`, `>`, `` ` ``, `$`)
/// disqualifies the whole command — `git diff && rm -rf .` must not pass on
/// its first word.
fn is_read_only_argv(argv: &[String], root: &Path) -> bool {
    if argv.iter().any(|arg| has_shell_metachar(arg)) {
        return false;
    }
    let mut tokens = argv.iter().map(String::as_str);
    if !matches!(tokens.next(), Some("git" | "git.exe")) {
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
    tokens.all(|token| !writes_or_leaves_repo(token) && !leaves_repo(token, root))
}

/// Options of the allowed subcommands that make git write a file (`diff`/`log`/
/// `show --output`) or read one outside the repository (`diff --no-index`,
/// `blame --contents`), or run an external diff program (`log -p`/`show
/// --ext-diff`). A targeted denylist: agents legitimately pass arbitrary
/// `--format`, `-n`, pathspecs and revisions, so an allowlist would be either
/// porous or constantly wrong. Options that read a file named by their value
/// (`blame -S`, `--ignore-revs-file`, `diff -O`) are covered by [`leaves_repo`].
const DENIED_OPTIONS: &[&str] = &["--output", "--no-index", "--contents", "--ext-diff"];

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

/// Could git read a file outside the repository, or inside its `.git`, from
/// this argument? `git diff` switches to `--no-index` on its own when a path
/// lies outside the work tree (`git diff /dev/null /etc/passwd`), and options
/// such as `blame -S<file>` or `--ignore-revs-file=<file>` read the file they
/// name and echo its lines in errors. So every value git might treat as a path
/// is judged like a reported `read` path ([`paths::escapes_repo`]): the
/// argument itself, a long option's value after `=`, and every tail of a
/// single-dash token (`-S/x`, and `-pS/x`, where `-S` takes `/x`). Revisions
/// such as `HEAD~1`, `main..feature` or `HEAD:src/a.rs` resolve inside the
/// repository and pass.
fn leaves_repo(token: &str, root: &Path) -> bool {
    if let Some(option) = token.strip_prefix("--") {
        return option
            .split_once('=')
            .is_some_and(|(_, value)| paths::escapes_repo(value, root));
    }
    if let Some(flags) = token.strip_prefix('-') {
        return flags
            .char_indices()
            .skip(1)
            .any(|(at, _)| paths::escapes_repo(&flags[at..], root));
    }
    paths::escapes_repo(token, root)
}

/// Would a shell expand `line` into other arguments than its tokens show?
/// Outside quotes, glob characters (`*` `?` `[` `]`, zsh's `*(e:cmd:)`
/// qualifiers), parentheses, backslashes, `!`, a `#` comment, braces (bash and
/// zsh brace expansion — only a `@{…}` reflog suffix without `,` or `..` is
/// kept), and a `~` or `=` that starts a word (`~/x`, `--opt=~/x`, zsh's
/// `=cmd`) are refused. Inside single quotes nothing expands; inside double
/// quotes only `$` and `` ` ``, which [`has_shell_metachar`] refuses anyway,
/// and `\`, refused here. An unterminated quote is refused too.
fn has_shell_expansion(line: &str) -> bool {
    let mut quote = None;
    let mut prev = ' ';
    let mut in_reflog_braces = false;
    for c in line.chars() {
        match quote {
            Some('\'') => {
                if c == '\'' {
                    quote = None;
                }
            }
            Some(_) => match c {
                '"' => quote = None,
                '\\' => return true,
                _ => {}
            },
            None => {
                let word_start = prev.is_whitespace() || matches!(prev, '=' | ':');
                match c {
                    '\'' | '"' => quote = Some(c),
                    '*' | '?' | '[' | ']' | '(' | ')' | '\\' | '!' => return true,
                    '#' | '=' if prev.is_whitespace() => return true,
                    '~' if word_start => return true,
                    '{' if prev == '@' && !in_reflog_braces => in_reflog_braces = true,
                    '}' if in_reflog_braces => in_reflog_braces = false,
                    '{' | '}' => return true,
                    ',' if in_reflog_braces => return true,
                    '.' if in_reflog_braces && prev == '.' => return true,
                    _ => {}
                }
            }
        }
        prev = c;
    }
    quote.is_some() || in_reflog_braces
}

/// Could a shell chain, redirect, or substitute on `text`? Any `$` (command
/// and variable expansion) and every ASCII control character (`\n`, `\r`,
/// `\0`, tab) count.
fn has_shell_metachar(text: &str) -> bool {
    text.contains([';', '&', '|', '>', '<', '`', '$']) || text.chars().any(|c| c.is_ascii_control())
}
