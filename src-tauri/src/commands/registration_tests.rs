mod argument_names;
mod runtime;
mod secret_paths;
mod thread_placement;

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

fn src_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// One `#[tauri::command]` signature as parsed from source text — enough
/// shape for the contract audits (name, thread placement, parameter names)
/// without a Rust parser.
struct CommandSig {
    name: String,
    /// Declared `async fn` (the `blocking()` shape) rather than a plain `fn`.
    is_async: bool,
    /// Parameter names in declaration order (`mut` stripped, types dropped).
    params: Vec<String>,
    /// The declared type of each entry in `params`, same order. Kept so the
    /// argument-name audit can tell a user-supplied parameter (which the
    /// frontend must pass) from one Tauri injects (`AppHandle`, `State`,
    /// `Webview`), which never appears in the invoke payload.
    param_types: Vec<String>,
    /// 1-based line of the `fn` item, for failure messages.
    line: usize,
}

/// Every `#[tauri::command]` signature in `source`, in declaration order. The
/// signature runs from the `fn` line to its opening brace; further attributes
/// between `#[tauri::command]` and the `fn` are skipped.
fn command_signatures(source: &str) -> Vec<CommandSig> {
    let lines: Vec<&str> = source.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].trim() == "#[tauri::command]" {
            let mut j = i + 1;
            while j < lines.len() && lines[j].trim_start().starts_with("#[") {
                j += 1;
            }
            let mut sig = String::new();
            let mut k = j;
            while k < lines.len() {
                sig.push_str(lines[k]);
                sig.push('\n');
                if lines[k].contains('{') {
                    break;
                }
                k += 1;
            }
            out.push(parse_signature(&sig, j + 1));
            i = k;
        }
        i += 1;
    }
    out
}

fn parse_signature(sig: &str, line: usize) -> CommandSig {
    let (header, rest) = sig
        .split_once("fn ")
        .unwrap_or_else(|| panic!("no fn after #[tauri::command] at line {line}: {sig}"));
    let name = rest.split(['(', '<']).next().unwrap().trim().to_string();
    let open = rest
        .find('(')
        .unwrap_or_else(|| panic!("no parameter list for `{name}` at line {line}"));
    // The parameter list ends at the paren that balances the opening one;
    // `tauri::State<'_, X>` puts commas and angle brackets inside a type, so
    // both bracket kinds count toward nesting.
    let params_text = &rest[open + 1..];
    let mut depth = 0usize;
    let mut close = None;
    for (idx, c) in params_text.char_indices() {
        match c {
            '(' | '<' => depth += 1,
            ')' | '>' if depth == 0 => {
                close = Some(idx);
                break;
            }
            ')' | '>' => depth -= 1,
            _ => {}
        }
    }
    let params_text = &params_text[..close.unwrap_or(params_text.len())];
    let mut params = Vec::new();
    let mut param_types = Vec::new();
    let mut depth = 0usize;
    let mut current = String::new();
    for c in params_text.chars().chain(std::iter::once(',')) {
        match c {
            '(' | '<' => depth += 1,
            ')' | '>' => depth -= 1,
            ',' if depth == 0 => {
                if let Some((param, ty)) = current.split_once(':') {
                    let param = param.trim().trim_start_matches("mut ").trim();
                    if !param.is_empty() {
                        params.push(param.to_string());
                        param_types.push(ty.trim().to_string());
                    }
                }
                current.clear();
                continue;
            }
            _ => {}
        }
        current.push(c);
    }
    CommandSig {
        name,
        is_async: header.contains("async"),
        params,
        param_types,
        line,
    }
}

/// Names of `#[tauri::command]` fns declared in `source`.
fn command_fns(source: &str) -> Vec<String> {
    command_signatures(source)
        .into_iter()
        .map(|sig| sig.name)
        .collect()
}

/// The source files that may declare commands: every module directly under
/// `commands/` (GL-360: impl modules never declare a `#[tauri::command]`).
fn command_source_files() -> Vec<PathBuf> {
    let dir = src_dir().join("commands");
    let mut files: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "rs"))
        .collect();
    files.sort();
    files
}

/// Every command declared under `commands/` — the one directory that may hold a `#[tauri::command]` (GL-360); impl modules never declare one.
fn declared_commands() -> Vec<String> {
    let mut all = Vec::new();
    for f in command_source_files() {
        all.extend(command_fns(&fs::read_to_string(f).unwrap()));
    }
    all
}

/// The fn names registered in `lib.rs`'s `generate_handler!` list.
fn registered_commands() -> Vec<String> {
    let lib = fs::read_to_string(src_dir().join("lib.rs")).unwrap();
    let start = lib.find("generate_handler![").expect("handler list") + "generate_handler![".len();
    let end = start + lib[start..].find(']').expect("handler list end");
    lib[start..end]
        .split(',')
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(|e| e.rsplit("::").next().unwrap().to_string())
        .collect()
}

/// Command names the frontend invokes as string literals in `src/lib/api/`.
///
/// Walks the tree, not just its top level: the git wrappers live in
/// `api/git/*.ts` (GL-341) and a non-recursive read would silently scan
/// zero of them while the remaining domains kept the set non-empty — the
/// guard would still pass and check nothing. `scans_the_nested_api_modules`
/// below fails if that regresses.
fn invoked_commands() -> BTreeSet<String> {
    let api_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/api");
    let mut names = BTreeSet::new();
    let mut pending = vec![api_dir];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            if path.extension().is_none_or(|e| e != "ts") {
                continue;
            }
            // Test files invoke through mocks with placeholder names; only
            // production wrappers are the contract.
            if path.to_string_lossy().ends_with(".test.ts") {
                continue;
            }
            let text = fs::read_to_string(path).unwrap();
            let bytes = text.as_bytes();
            let mut from = 0;
            while let Some(pos) = text[from..].find("invoke") {
                let mut i = from + pos + "invoke".len();
                from = i;
                // skip a generic argument list, tracking nesting
                if bytes.get(i) == Some(&b'<') {
                    let mut depth = 0usize;
                    while let Some(&c) = bytes.get(i) {
                        if c == b'<' {
                            depth += 1;
                        } else if c == b'>' {
                            depth -= 1;
                            if depth == 0 {
                                i += 1;
                                break;
                            }
                        }
                        i += 1;
                    }
                }
                if bytes.get(i) != Some(&b'(') {
                    continue; // an `invoke` mention, not a call (import, comment)
                }
                i += 1;
                while bytes.get(i).is_some_and(|c| c.is_ascii_whitespace()) {
                    i += 1;
                }
                if bytes.get(i) != Some(&b'"') {
                    continue; // dynamic command name — not checkable here
                }
                i += 1;
                let name_start = i;
                while bytes
                    .get(i)
                    .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
                {
                    i += 1;
                }
                if bytes.get(i) == Some(&b'"') && i > name_start {
                    names.insert(text[name_start..i].to_string());
                }
            }
        }
    }
    names
}

#[test]
fn every_declared_command_is_registered_exactly_once() {
    let declared = declared_commands();
    let registered = registered_commands();
    let declared_set: BTreeSet<_> = declared.iter().cloned().collect();
    let registered_set: BTreeSet<_> = registered.iter().cloned().collect();
    assert_eq!(
        declared.len(),
        declared_set.len(),
        "duplicate command declarations"
    );
    assert_eq!(
        registered.len(),
        registered_set.len(),
        "duplicate handler entries"
    );
    let missing: Vec<_> = declared_set.difference(&registered_set).collect();
    assert!(
        missing.is_empty(),
        "declared but not in generate_handler!: {missing:?}"
    );
    let stale: Vec<_> = registered_set.difference(&declared_set).collect();
    assert!(
        stale.is_empty(),
        "in generate_handler! but not declared: {stale:?}"
    );
}

/// Every command rejects with the structured `CommandError` (`ipc/commands`
/// spec). A `Result<_, String>` signature compiles and serialises fine, so
/// only this test stops the stringly-typed boundary from creeping back.
#[test]
fn no_command_returns_a_string_error() {
    let mut offenders = Vec::new();
    let mut bypasses = Vec::new();
    for file in command_source_files() {
        let source = fs::read_to_string(&file).unwrap();
        let lines: Vec<&str> = source.lines().collect();
        let mut i = 0;
        while i < lines.len() {
            if lines[i].trim() == "#[tauri::command]" {
                // The signature runs from the fn line to its opening brace.
                let mut sig = String::new();
                let mut j = i + 1;
                while j < lines.len() {
                    sig.push_str(lines[j]);
                    if lines[j].contains('{') {
                        break;
                    }
                    j += 1;
                }
                // Only the return type matters — a `BTreeMap<String, String>`
                // parameter is not a string error.
                let ret = sig.rsplit("->").next().unwrap_or("");
                if ret.contains(", String>") {
                    offenders.push(format!("{}:{}", file.display(), i + 2));
                }
                // A `Result` command must also *produce* its error through
                // one of the adapters, or the redaction step is bypassed.
                if ret.contains("Result<") {
                    let mut body = String::new();
                    let mut k = j + 1;
                    while k < lines.len() && lines[k] != "}" {
                        body.push_str(lines[k]);
                        k += 1;
                    }
                    // `forge_op` (commands/github.rs) is the PR commands'
                    // shared prologue and itself runs inside `blocking`.
                    if !["blocking(", "sync(", "boundary(", "forge_op("]
                        .iter()
                        .any(|adapter| body.contains(adapter))
                    {
                        bypasses.push(format!("{}:{}", file.display(), i + 2));
                    }
                }
                i = j;
            }
            i += 1;
        }
    }
    assert!(
        offenders.is_empty(),
        "commands must reject with CommandError, not String: {offenders:?}"
    );
    assert!(
        bypasses.is_empty(),
        "commands must produce their error through blocking()/sync()/boundary(): {bypasses:?}"
    );
}

#[test]
fn frontend_invokes_only_registered_commands() {
    let registered: BTreeSet<_> = registered_commands().into_iter().collect();
    let invoked = invoked_commands();
    assert!(
        !invoked.is_empty(),
        "found no invoke() literals — parser broken?"
    );
    let unknown: Vec<_> = invoked.difference(&registered).collect();
    assert!(
        unknown.is_empty(),
        "frontend invokes unregistered commands: {unknown:?}"
    );
}

/// `invoked_commands` reports a non-empty set as long as *any* api module
/// is scanned, so a directory it stops walking goes unnoticed — the guard
/// keeps passing while silently checking less. Pin one command per nested
/// module directory so that failure is loud.
#[test]
fn scans_the_nested_api_modules() {
    let invoked = invoked_commands();
    for name in ["open_repo", "commit", "working_changes", "stage_files"] {
        assert!(
            invoked.contains(name),
            "`{name}` was not scanned — the api walk is missing src/lib/api/git/",
        );
    }
}

/// Pin the signature parser the audits above rely on: a multi-line `async`
/// signature whose `State<'_, X>` parameter hides a comma inside its type, a
/// second attribute after `#[tauri::command]`, and a plain sync command.
///
/// The fixture spells the attribute as `@command` and substitutes it at
/// runtime: this file sits under `commands/`, so a literal attribute line
/// here would be scanned as a real declaration by the audits above.
#[test]
fn parses_command_signatures() {
    let source = "\
@command
#[allow(clippy::too_many_arguments)]
pub async fn clone_repo(
    app: tauri::AppHandle,
    state: tauri::State<'_, CloneState>,
    mut url: String,
    auth: Option<GitTransportAuthRef>,
) -> Result<String, CommandError> {
    todo!()
}

@command
pub fn cancel_clone(state: tauri::State<'_, CloneState>) -> Result<(), CommandError> {
    todo!()
}
"
    .replace("@command", "#[tauri::command]");
    let sigs = command_signatures(&source);
    let summary: Vec<_> = sigs
        .iter()
        .map(|s| (s.name.as_str(), s.is_async, s.params.clone(), s.line))
        .collect();
    assert_eq!(
        summary,
        vec![
            (
                "clone_repo",
                true,
                vec![
                    "app".to_string(),
                    "state".to_string(),
                    "url".to_string(),
                    "auth".to_string()
                ],
                3
            ),
            ("cancel_clone", false, vec!["state".to_string()], 13),
        ]
    );
}
