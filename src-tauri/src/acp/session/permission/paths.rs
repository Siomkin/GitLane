//! Whether a `read` / `search` tool call stays inside the session repository,
//! judged from what the adapter reports about it.
//!
//! GitLane advertises `readTextFile: false`, so the adapter reads files itself
//! and this gate sees only its report. Every string in `rawInput` (at any depth,
//! under any key) and every `locations[].path` is a candidate: a list of known
//! path keys would let a path under any other key through unchecked.

use serde_json::Value;
use std::path::{Component, Path, PathBuf};

/// What one reported value turned out to be.
enum Verdict {
    /// Points outside the repository or into its `.git`.
    Escapes,
    /// An existing regular file inside the repository.
    RepoFile,
    /// Inside the repository but not an existing file (a directory, a path
    /// still to be created), or not a path at all (a search term, a glob).
    Harmless,
}

/// Do all the paths `call` reports stay inside `cwd`, outside its `.git`? A
/// `read` must also name at least one existing file inside the repository; a
/// `search` that names no path runs in the session `cwd`.
pub(super) fn paths_stay_in_repo(call: &Value, cwd: &Path, kind: &str) -> bool {
    let Ok(root) = cwd.canonicalize() else {
        return false;
    };
    let mut candidates = Vec::new();
    if let Some(raw) = call.get("rawInput") {
        collect_strings(raw, &mut candidates);
    }
    if let Some(locations) = call.get("locations").and_then(Value::as_array) {
        candidates.extend(
            locations
                .iter()
                .filter_map(|location| location.get("path").and_then(Value::as_str)),
        );
    }
    let mut named_repo_file = false;
    for candidate in candidates {
        match judge(candidate, &root) {
            Verdict::Escapes => return false,
            Verdict::RepoFile => named_repo_file = true,
            Verdict::Harmless => {}
        }
    }
    kind != "read" || named_repo_file
}

fn collect_strings<'a>(value: &'a Value, out: &mut Vec<&'a str>) {
    match value {
        Value::String(text) => out.push(text),
        Value::Array(items) => items.iter().for_each(|item| collect_strings(item, out)),
        Value::Object(fields) => fields.values().for_each(|item| collect_strings(item, out)),
        _ => {}
    }
}

/// Judge one reported value against the canonical repository `root`.
fn judge(value: &str, root: &Path) -> Verdict {
    let value = value.trim();
    if value.is_empty() {
        return Verdict::Harmless;
    }
    // Adapters report resolved paths; GitLane does not expand a home directory.
    if value.starts_with('~') {
        return Verdict::Escapes;
    }
    let path = Path::new(value);
    if has_git_component(path) {
        return Verdict::Escapes;
    }
    // `has_root` as well as `is_absolute`: on Windows `/etc/passwd` is rooted
    // but not absolute, and must not pass as a search term.
    let absolute_or_parent = path.has_root()
        || path.is_absolute()
        || path.components().any(|c| c == Component::ParentDir);
    let joined = root.join(path);
    if absolute_or_parent {
        return match resolve_nearest(&joined) {
            Some(resolved) if stays_in(&resolved, root) => existing_kind(&resolved),
            _ => Verdict::Escapes,
        };
    }
    // A relative value that exists may still pass through a symlink.
    match joined.canonicalize() {
        Ok(resolved) if stays_in(&resolved, root) => existing_kind(&resolved),
        Ok(_) => Verdict::Escapes,
        Err(_) => Verdict::Harmless,
    }
}

fn existing_kind(resolved: &Path) -> Verdict {
    if resolved.is_file() {
        Verdict::RepoFile
    } else {
        Verdict::Harmless
    }
}

/// Inside `root` (the root itself counts) and outside its `.git`.
fn stays_in(resolved: &Path, root: &Path) -> bool {
    resolved
        .strip_prefix(root)
        .is_ok_and(|inner| !has_git_component(inner))
}

fn has_git_component(path: &Path) -> bool {
    path.components()
        .any(|c| matches!(c, Component::Normal(name) if name.eq_ignore_ascii_case(".git")))
}

/// Canonicalise the nearest existing ancestor of `path` and append the rest.
/// `None` when no ancestor resolves or a `..` sits in the part that does not
/// exist yet (it cannot be resolved without guessing, so it fails closed).
fn resolve_nearest(path: &Path) -> Option<PathBuf> {
    let mut existing = path;
    let mut rest = Vec::new();
    loop {
        if let Ok(mut resolved) = existing.canonicalize() {
            resolved.extend(rest.iter().rev());
            return Some(resolved);
        }
        // `file_name` is `None` for a trailing `..` or the root.
        rest.push(existing.file_name()?);
        existing = existing.parent()?;
    }
}
