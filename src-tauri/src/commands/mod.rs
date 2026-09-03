//! The Tauri command layer, one module per domain (GL-360). Each command here
//! is registered in `lib.rs`'s single path-qualified `generate_handler!` list.
//!
//! Every command rejects with a [`CommandError`] (`ipc/commands` spec): the
//! [`blocking`] / [`sync`] adapters below are the one place an internal error
//! becomes the boundary type, gets classified, and is redacted — so no command
//! can bypass either step by construction.
//!
//! `CommandError` carries five optional context strings and trips clippy's
//! 128-byte `result_large_err` threshold. It crosses IPC exactly once per
//! command and is never returned in a hot loop, so the boxing the lint asks
//! for would only add an allocation on the failure path.
#![allow(clippy::result_large_err)]

pub mod auth;
pub mod branches;
pub mod commits;
pub mod conflicts;
pub mod files;
pub mod github;
pub mod identity;
pub mod recovery;
pub mod remotes;
pub mod repo;
pub mod staging;
pub mod status;
pub mod tags;
pub mod terminal;
pub mod worktrees;

pub use crate::git::types::CommandError;

/// Run blocking work (a `git`/`gh` subprocess) off the webview's main thread.
/// Synchronous Tauri commands execute on the main thread, so a blocking
/// subprocess there freezes the whole UI (no repaint) until it returns; wrapping
/// the work in `spawn_blocking` keeps the UI responsive. In-process libgit2
/// reads stay synchronous — they're fast and don't shell out.
///
/// The closure may fail with anything that converts into [`CommandError`]
/// (`String` diagnostics are classified, `git2::Error`s are typed, the forge
/// and OAuth enums map by variant). The result is redacted before it returns.
pub async fn blocking<T, E, F>(f: F) -> Result<T, CommandError>
where
    F: FnOnce() -> Result<T, E> + Send + 'static,
    E: Into<CommandError> + Send + 'static,
    T: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(result) => boundary(result),
        Err(join) => Err(CommandError::internal(format!("git task failed: {join:?}"))),
    }
}

/// The synchronous twin of [`blocking`] for commands that are instant by
/// design (lock-and-kill cancels, PTY writes, in-process metadata reads):
/// same conversion and redaction, no thread hop.
pub fn sync<T, E, F>(f: F) -> Result<T, CommandError>
where
    F: FnOnce() -> Result<T, E>,
    E: Into<CommandError>,
{
    boundary(f())
}

/// Convert + redact an already-computed result. The one adapter for commands
/// whose work is genuinely `async` (the updater's HTTP check) and so cannot sit
/// inside a `blocking` closure; `blocking` and `sync` funnel through it too.
pub fn boundary<T, E>(result: Result<T, E>) -> Result<T, CommandError>
where
    E: Into<CommandError>,
{
    result.map_err(|e| e.into().redacted())
}
/// Guard the declaration/registration/invocation parity that the compiler
/// cannot: a `#[tauri::command]` fn missing from `lib.rs`'s
/// `generate_handler!` list compiles fine and only fails at runtime with
/// "command not found" (the #1 IPC footgun), and a frontend `invoke("…")`
/// naming an unregistered command fails the same way.
#[cfg(test)]
mod registration_tests {
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn src_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
    }

    /// Names of `#[tauri::command]` fns declared in `source`.
    fn command_fns(source: &str) -> Vec<String> {
        let lines: Vec<&str> = source.lines().collect();
        let mut out = Vec::new();
        let mut i = 0;
        while i < lines.len() {
            if lines[i].trim() == "#[tauri::command]" {
                let mut j = i + 1;
                while lines[j].trim_start().starts_with("#[") {
                    j += 1;
                }
                let sig = lines[j];
                let name = sig
                    .split("fn ")
                    .nth(1)
                    .unwrap_or_else(|| panic!("no fn after #[tauri::command]: {sig}"))
                    .split(['(', '<'])
                    .next()
                    .unwrap()
                    .trim();
                out.push(name.to_string());
                i = j;
            }
            i += 1;
        }
        out
    }

    /// Every command declared under `commands/` or `updater.rs`.
    fn declared_commands() -> Vec<String> {
        let mut all = Vec::new();
        let dir = src_dir().join("commands");
        let mut files: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|e| e == "rs"))
            .collect();
        files.push(src_dir().join("updater.rs"));
        files.sort();
        for f in files {
            all.extend(command_fns(&fs::read_to_string(f).unwrap()));
        }
        all
    }

    /// The fn names registered in `lib.rs`'s `generate_handler!` list.
    fn registered_commands() -> Vec<String> {
        let lib = fs::read_to_string(src_dir().join("lib.rs")).unwrap();
        let start =
            lib.find("generate_handler![").expect("handler list") + "generate_handler![".len();
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
        let mut files: Vec<_> = fs::read_dir(src_dir().join("commands"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|e| e == "rs"))
            .collect();
        files.push(src_dir().join("updater.rs"));
        let mut offenders = Vec::new();
        let mut bypasses = Vec::new();
        for file in files {
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
        for name in ["open_repo", "commit", "working_changes", "stage_file"] {
            assert!(
                invoked.contains(name),
                "`{name}` was not scanned — the api walk is missing src/lib/api/git/",
            );
        }
    }
}
