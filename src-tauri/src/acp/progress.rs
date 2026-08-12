//! Turning `tool_call` updates into the short human labels the progress
//! banner shows.

use serde_json::Value;

/// A short label for the waiting UI, derived from one `session/update`.
/// Prefer a human verb plus a truncated detail so a bare `git show …` never
/// lands alone in the banner. Full home paths are shortened to a basename.
pub(super) fn progress_label(value: &Value) -> Option<String> {
    let update = value.pointer("/params/update")?;
    let session_update = update.get("sessionUpdate").and_then(Value::as_str)?;
    match session_update {
        "tool_call" | "tool_call_update" => {
            let kind = update.get("kind").and_then(Value::as_str);
            let title = update
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|title| !title.is_empty());
            let detail = tool_input_detail(update).or_else(|| title.map(str::to_owned));
            // Untitled unknown kinds must not freeze the banner on "Working…".
            if detail.is_none() && matches!(kind, None | Some("other")) {
                return None;
            }
            Some(format_progress(kind, detail.as_deref()))
        }
        _ => None,
    }
}

/// Verb for a tool kind when we have no better detail.
fn tool_kind_verb(kind: Option<&str>) -> &'static str {
    match kind.unwrap_or("") {
        "read" => "Reading",
        "search" => "Searching",
        "execute" => "Running",
        "think" => "Thinking",
        "fetch" => "Fetching",
        "edit" | "delete" | "move" => "Editing",
        _ => "Working",
    }
}

/// `Running · git show …` / `Reading · foo.md` / bare verb when there's nothing
/// useful to attach. Never returns a naked command without a title.
fn format_progress(kind: Option<&str>, detail: Option<&str>) -> String {
    let verb = tool_kind_verb(kind);
    let Some(raw) = detail.map(str::trim).filter(|d| !d.is_empty()) else {
        return format!("{verb}…");
    };
    // Title already carries a verb — keep it, just truncate.
    if looks_titled(raw) {
        return truncate_for_progress(raw, 72);
    }
    let shown = if looks_like_path(raw) {
        basename_for_progress(raw)
    } else {
        truncate_for_progress(raw, 56)
    };
    // Infer a better verb from the detail when kind is missing/other.
    let verb = if kind.is_none() || kind == Some("other") {
        infer_verb_from_detail(raw).unwrap_or(verb)
    } else {
        verb
    };
    format!("{verb} · {shown}")
}

fn looks_titled(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.starts_with("reading")
        || lower.starts_with("running")
        || lower.starts_with("searching")
        || lower.starts_with("thinking")
        || lower.starts_with("fetching")
        || lower.starts_with("editing")
        || lower.starts_with("writing")
        || lower.starts_with("working")
}

fn looks_like_path(text: &str) -> bool {
    let t = text.trim().trim_matches('\'');
    t.starts_with('/') || t.starts_with('~') || t.contains('/') || t.contains('\\')
}

fn basename_for_progress(text: &str) -> String {
    let cleaned = text
        .trim()
        .trim_start_matches("Read file ")
        .trim_matches('\'')
        .trim_matches('"');
    let name = cleaned.rsplit(['/', '\\']).next().unwrap_or(cleaned).trim();
    if name.is_empty() {
        return truncate_for_progress(cleaned, 40);
    }
    truncate_for_progress(name, 40)
}

fn infer_verb_from_detail(detail: &str) -> Option<&'static str> {
    let lower = detail.to_ascii_lowercase();
    if lower.starts_with("git ")
        || lower.contains("git show")
        || lower.contains("git diff")
        || lower.contains("&&")
        || lower.starts_with("run")
    {
        return Some("Running");
    }
    if lower.starts_with("read") || looks_like_path(detail) {
        return Some("Reading");
    }
    if lower.contains("search") || lower.contains("grep") {
        return Some("Searching");
    }
    if lower.contains("think") {
        return Some("Thinking");
    }
    if lower.contains("edit") || lower.contains("write") {
        return Some("Editing");
    }
    None
}

fn tool_input_detail(update: &Value) -> Option<String> {
    let raw = update.get("rawInput")?;
    first_string_field(raw, &["command"]).or_else(|| first_string_field(raw, &["path"]))
}

fn first_string_field(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str).map(str::trim) {
            if !text.is_empty() {
                return Some(text.to_owned());
            }
        }
    }
    None
}

pub(super) fn truncate_for_progress(text: &str, max: usize) -> String {
    let trimmed = text.trim().trim_matches('`');
    if trimmed.chars().count() <= max {
        return trimmed.to_owned();
    }
    let mut out = trimmed
        .chars()
        .take(max.saturating_sub(1))
        .collect::<String>();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_label_titles_commands_and_shortens_paths() {
        let codex_read = serde_json::json!({
            "params": { "update": {
                "sessionUpdate": "tool_call",
                "title": "Read file '/Users/me/.codex/plugins/cache/ponytail/foo.md'",
                "kind": "read"
            }}
        });
        assert_eq!(
            progress_label(&codex_read).as_deref(),
            Some("Reading · foo.md")
        );
        let titled = serde_json::json!({
            "params": { "update": {
                "sessionUpdate": "tool_call",
                "title": "  git diff --staged  ",
                "kind": "execute"
            }}
        });
        assert_eq!(
            progress_label(&titled).as_deref(),
            Some("Running · git diff --staged")
        );
        let kind_only = serde_json::json!({
            "params": { "update": {
                "sessionUpdate": "tool_call_update",
                "kind": "read"
            }}
        });
        assert_eq!(progress_label(&kind_only).as_deref(), Some("Reading…"));
        let bare = serde_json::json!({
            "params": { "update": {
                "sessionUpdate": "tool_call",
                "kind": "other"
            }}
        });
        assert_eq!(progress_label(&bare), None);
        let with_cmd = serde_json::json!({
            "params": { "update": {
                "sessionUpdate": "tool_call",
                "kind": "execute",
                "rawInput": { "command": "git diff --staged" }
            }}
        });
        assert_eq!(
            progress_label(&with_cmd).as_deref(),
            Some("Running · git diff --staged")
        );
        let thought = serde_json::json!({
            "params": { "update": {
                "sessionUpdate": "agent_thought_chunk",
                "content": { "type": "text", "text": "hmm" }
            }}
        });
        assert_eq!(progress_label(&thought), None);
        let git_show = serde_json::json!({
            "params": { "update": {
                "sessionUpdate": "tool_call",
                "title": "git show ca9a464a22b7 --stat && echo \"---DIFF---\" && git show ca9a464a22b7 --no-stat"
            }}
        });
        let label = progress_label(&git_show).unwrap();
        assert!(label.starts_with("Running · git show "), "{label}");
    }
}
