//! The Tauri command layer, one module per domain (GL-360). Each command here
//! is registered in `lib.rs`'s single path-qualified `generate_handler!` list.

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

/// Run blocking work (a `git`/`gh` subprocess) off the webview's main thread.
/// Synchronous Tauri commands execute on the main thread, so a blocking
/// subprocess there freezes the whole UI (no repaint) until it returns; wrapping
/// the work in `spawn_blocking` keeps the UI responsive. In-process libgit2
/// reads stay synchronous — they're fast and don't shell out.
pub async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("git task failed: {e:?}"))?
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
    fn invoked_commands() -> BTreeSet<String> {
        let api_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/api");
        let mut names = BTreeSet::new();
        for entry in fs::read_dir(api_dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|e| e != "ts") {
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
}
