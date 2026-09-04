//! Argument-name audit: the Rust parameter names and the object keys the
//! frontend passes to `invoke` are one contract, and nothing checks it.
//!
//! Tauri maps a camelCase key in the invoke payload onto a snake_case Rust
//! parameter (`startPoint` → `start_point`). Rename one side and both halves
//! still compile, both type-check, and the command fails only when a user
//! triggers it — with a deserialization error naming a field, not the rename.
//! `commands/mod.rs`'s sibling audits catch a missing *command*; this catches a
//! missing *argument*.
//!
//! Two directions, because each catches a different slip:
//!
//! * every key the frontend sends must name a real parameter — catches a
//!   rename on the Rust side, and a typo on the JS side;
//! * every required Rust parameter must be sent by some caller — catches a
//!   rename on the JS side. `Option<T>` parameters are exempt: omitting them is
//!   how the frontend spells `None`.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use super::{command_signatures, command_source_files};

/// Parameters Tauri injects rather than the frontend passing them.
fn is_injected(ty: &str) -> bool {
    let ty = ty.replace(' ', "");
    [
        "AppHandle",
        "State<",
        "Webview",
        "Window<",
        "Channel<",
        "ipc::",
    ]
    .iter()
    .any(|marker| ty.contains(marker))
}

/// `startPoint` → `start_point`. Tauri's own mapping, applied to a key.
fn to_snake_case(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 4);
    for c in key.chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// The `src/lib/api` wrappers, walked recursively — the git wrappers live in
/// `api/git/*.ts` (GL-341). Test files are skipped: they invoke through mocks
/// with placeholder payloads.
fn api_files() -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/api");
    let mut files = Vec::new();
    let mut pending = vec![root];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else if path.extension().is_some_and(|e| e == "ts")
                && !path.to_string_lossy().ends_with(".test.ts")
            {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

/// Every `invoke("<cmd>", { … })` in `source` as `(command, payload keys)`.
///
/// Only depth-1 keys of the payload object count — a nested object is the
/// command's own argument shape, not further parameters. A call with no payload
/// yields an empty set, which is still meaningful (it asserts the command takes
/// no required arguments).
fn invoked_arguments(source: &str) -> Vec<(String, BTreeSet<String>)> {
    let bytes = source.as_bytes();
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(pos) = source[from..].find("invoke") {
        let mut i = from + pos + "invoke".len();
        from = i;
        // Skip a generic argument list, tracking nesting.
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
        let quote = match bytes.get(i) {
            Some(&c @ (b'"' | b'\'' | b'`')) => c,
            // A computed command name is not a literal contract; skip it.
            _ => continue,
        };
        i += 1;
        let start = i;
        while bytes.get(i).is_some_and(|&c| c != quote) {
            i += 1;
        }
        let command = source[start..i].to_string();
        i += 1;
        while bytes.get(i).is_some_and(|c| c.is_ascii_whitespace()) {
            i += 1;
        }
        if bytes.get(i) != Some(&b',') {
            out.push((command, BTreeSet::new()));
            continue;
        }
        i += 1;
        while bytes.get(i).is_some_and(|c| c.is_ascii_whitespace()) {
            i += 1;
        }
        if bytes.get(i) != Some(&b'{') {
            // A spread or a variable payload — nothing literal to check.
            continue;
        }
        out.push((command, payload_keys(source, &mut i)));
    }
    out
}

/// Keys of the object literal starting at `i` (which indexes its `{`).
fn payload_keys(source: &str, i: &mut usize) -> BTreeSet<String> {
    let bytes = source.as_bytes();
    let mut keys = BTreeSet::new();
    let mut depth = 0usize;
    let mut token = String::new();
    let mut awaiting_value = false;
    while let Some(&c) = bytes.get(*i) {
        match c {
            b'{' | b'[' | b'(' => {
                depth += 1;
                token.clear();
            }
            b'}' | b']' | b')' => {
                if depth == 1 && c == b'}' {
                    if !awaiting_value && !token.trim().is_empty() {
                        keys.insert(token.trim().to_string());
                    }
                    *i += 1;
                    break;
                }
                depth -= 1;
                token.clear();
            }
            b':' if depth == 1 => {
                if !token.trim().is_empty() {
                    keys.insert(token.trim().to_string());
                }
                token.clear();
                awaiting_value = true;
            }
            b',' if depth == 1 => {
                if !awaiting_value && !token.trim().is_empty() {
                    keys.insert(token.trim().to_string());
                }
                token.clear();
                awaiting_value = false;
            }
            _ if depth == 1 && !awaiting_value => {
                if c == b'.' {
                    // A `...spread` carries no literal keys.
                    token.clear();
                } else if c.is_ascii_alphanumeric() || c == b'_' || c == b'$' {
                    token.push(c as char);
                } else if !c.is_ascii_whitespace() {
                    token.clear();
                }
            }
            _ => {}
        }
        *i += 1;
    }
    keys
}

/// Required (non-`Option`) user-supplied parameters, by command.
fn required_parameters() -> BTreeMap<String, BTreeSet<String>> {
    let mut out = BTreeMap::new();
    for file in command_source_files() {
        let source = fs::read_to_string(&file).unwrap();
        for sig in command_signatures(&source) {
            let required = sig
                .params
                .iter()
                .zip(sig.param_types.iter())
                .filter(|(_, ty)| !is_injected(ty))
                .filter(|(_, ty)| !ty.replace(' ', "").starts_with("Option<"))
                .map(|(name, _)| name.clone())
                .collect();
            out.insert(sig.name, required);
        }
    }
    out
}

/// Every user-supplied parameter (required or optional), by command.
fn all_parameters() -> BTreeMap<String, BTreeSet<String>> {
    let mut out = BTreeMap::new();
    for file in command_source_files() {
        let source = fs::read_to_string(&file).unwrap();
        for sig in command_signatures(&source) {
            let names = sig
                .params
                .iter()
                .zip(sig.param_types.iter())
                .filter(|(_, ty)| !is_injected(ty))
                .map(|(name, _)| name.clone())
                .collect();
            out.insert(sig.name, names);
        }
    }
    out
}

/// Every literal `invoke` payload across the API wrappers.
fn frontend_payloads() -> Vec<(String, BTreeSet<String>)> {
    api_files()
        .iter()
        .flat_map(|file| invoked_arguments(&fs::read_to_string(file).unwrap()))
        .collect()
}

#[test]
fn every_invoke_key_names_a_real_parameter() {
    let declared = all_parameters();
    let mut unknown = Vec::new();
    for (command, keys) in frontend_payloads() {
        let Some(params) = declared.get(&command) else {
            continue; // an unregistered command is the sibling audit's job
        };
        for key in keys {
            let snake = to_snake_case(&key);
            if !params.contains(&snake) {
                unknown.push(format!(
                    "{command}: frontend sends `{key}` (→ `{snake}`), which is not a parameter of the Rust command (has: {})",
                    params.iter().cloned().collect::<Vec<_>>().join(", ")
                ));
            }
        }
    }
    assert!(
        unknown.is_empty(),
        "invoke payload keys with no matching Rust parameter:\n{}",
        unknown.join("\n")
    );
}

#[test]
fn every_required_parameter_is_sent_by_some_caller() {
    let required = required_parameters();
    let mut sent: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut invoked = BTreeSet::new();
    for (command, keys) in frontend_payloads() {
        invoked.insert(command.clone());
        sent.entry(command)
            .or_default()
            .extend(keys.iter().map(|key| to_snake_case(key)));
    }

    let mut missing = Vec::new();
    for (command, params) in required {
        // A command with no literal wrapper call has nothing to compare against.
        if !invoked.contains(&command) {
            continue;
        }
        let sent = sent.get(&command).cloned().unwrap_or_default();
        for param in params {
            if !sent.contains(&param) {
                missing.push(format!(
                    "{command}: Rust requires `{param}`, which no caller sends (sends: {})",
                    sent.iter().cloned().collect::<Vec<_>>().join(", ")
                ));
            }
        }
    }
    assert!(
        missing.is_empty(),
        "required Rust parameters no frontend caller passes:\n{}",
        missing.join("\n")
    );
}

#[cfg(test)]
mod parsing {
    use super::*;

    #[test]
    fn maps_camel_case_keys_onto_snake_case_parameters() {
        assert_eq!(to_snake_case("startPoint"), "start_point");
        assert_eq!(to_snake_case("path"), "path");
        assert_eq!(to_snake_case("expectedOid"), "expected_oid");
        assert_eq!(to_snake_case("sessionId"), "session_id");
    }

    #[test]
    fn reads_shorthand_and_explicit_payload_keys() {
        let source = r#"
            await invoke("checkout", { path, target, detached });
            await invoke("rename_branch", { path, old: oldName, new: newName });
        "#;

        let calls = invoked_arguments(source);

        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, "checkout");
        assert_eq!(
            calls[0].1,
            ["detached", "path", "target"]
                .map(String::from)
                .into_iter()
                .collect()
        );
        // The key is the contract, not the local variable it is filled from.
        assert_eq!(
            calls[1].1,
            ["new", "old", "path"]
                .map(String::from)
                .into_iter()
                .collect()
        );
    }

    #[test]
    fn takes_only_top_level_keys_of_a_nested_payload() {
        let source = r#"await invoke("commit", { path, opts: { amend: true, sign: false } });"#;

        let calls = invoked_arguments(source);

        assert_eq!(
            calls[0].1,
            ["opts", "path"].map(String::from).into_iter().collect(),
            "amend/sign belong to the argument's own shape"
        );
    }

    #[test]
    fn handles_a_generic_call_and_a_payloadless_one() {
        let source = r#"
            await invoke<string>("list_branches", { path });
            await invoke("check_update");
        "#;

        let calls = invoked_arguments(source);

        assert_eq!(calls[0].0, "list_branches");
        assert_eq!(calls[0].1, ["path"].map(String::from).into_iter().collect());
        assert_eq!(calls[1].0, "check_update");
        assert!(calls[1].1.is_empty());
    }

    #[test]
    fn a_rename_on_either_side_alone_is_a_mismatch() {
        // The audit's whole point, on synthetic input so it does not depend on
        // the tree currently being correct.
        let rust: BTreeSet<String> = ["path", "start_point"]
            .map(String::from)
            .into_iter()
            .collect();

        let sent: BTreeSet<String> =
            invoked_arguments(r#"invoke("create_branch", { path, startPoint });"#)[0]
                .1
                .iter()
                .map(|key| to_snake_case(key))
                .collect();
        assert!(
            sent.iter().all(|key| rust.contains(key)),
            "matching sides agree"
        );

        // JS renamed: `beginAt` reaches no Rust parameter.
        let renamed_js: BTreeSet<String> =
            invoked_arguments(r#"invoke("create_branch", { path, beginAt });"#)[0]
                .1
                .iter()
                .map(|key| to_snake_case(key))
                .collect();
        assert!(renamed_js.iter().any(|key| !rust.contains(key)));

        // Rust renamed: nothing sends `begin_at`.
        let renamed_rust: BTreeSet<String> =
            ["path", "begin_at"].map(String::from).into_iter().collect();
        assert!(renamed_rust.iter().any(|param| !sent.contains(param)));
    }

    #[test]
    fn tauri_injected_parameters_are_not_expected_from_the_frontend() {
        assert!(is_injected("tauri::AppHandle"));
        assert!(is_injected("tauri::State<'_, WatcherState>"));
        assert!(is_injected("tauri::Webview"));
        assert!(!is_injected("String"));
        assert!(!is_injected("Option<String>"));
        assert!(!is_injected("u64"));
    }
}
