//! `git/` never touches the Tauri runtime (architecture-rules-rust.md §4). The
//! command layer adapts: it resolves app-data paths and turns a progress
//! callback into `crate::events::emit`. Code under `git/` that takes an
//! `AppHandle` cannot be driven by a unit test without the developer's real
//! app-data dir, which is why the OAuth orchestration went untested for so long.

use std::fs;
use std::path::{Path, PathBuf};

use super::src_dir;

/// Every `.rs` file under `src/git`, recursively.
fn git_sources() -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }
    let mut files = Vec::new();
    walk(&src_dir().join("git"), &mut files);
    files.sort();
    files
}

/// Lines of `source` that name the Tauri runtime outside a comment. Doc and line
/// comments may mention it — several explain why the code *doesn't* use it.
fn tauri_uses(source: &str) -> Vec<(usize, String)> {
    source
        .lines()
        .enumerate()
        .filter(|(_, line)| {
            let code = line.split("//").next().unwrap_or("");
            code.contains("tauri::") || code.contains("AppHandle")
        })
        .map(|(n, line)| (n + 1, line.trim().to_string()))
        .collect()
}

#[test]
fn nothing_under_git_names_the_tauri_runtime() {
    let files = git_sources();
    assert!(
        files.len() > 100,
        "walked too few git/ sources: {}",
        files.len()
    );

    let offenders: Vec<String> = files
        .iter()
        .flat_map(|path| {
            let source = fs::read_to_string(path).unwrap();
            let rel = path.strip_prefix(src_dir()).unwrap().display().to_string();
            tauri_uses(&source)
                .into_iter()
                .map(move |(line, text)| format!("{rel}:{line}: {text}"))
        })
        .collect();

    assert!(
        offenders.is_empty(),
        "git/ must stay Tauri-free — take a `&dyn Fn` progress callback and a `&Path`, \
         and let the command in commands/ adapt the AppHandle:\n{}",
        offenders.join("\n")
    );
}

#[test]
fn the_scan_sees_code_and_ignores_comments() {
    let source = "//! Progress is a callback rather than an `AppHandle`.\n\
                  use tauri::AppHandle;\n\
                  fn f() {} // not tauri::AppHandle\n\
                  fn g(app: &AppHandle) {}\n";

    let lines: Vec<usize> = tauri_uses(source).into_iter().map(|(n, _)| n).collect();

    assert_eq!(lines, [2, 4]);
}
