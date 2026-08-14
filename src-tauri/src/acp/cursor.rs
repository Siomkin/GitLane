//! Cursor's CLI quirks: it advertises one effort preset per model over ACP
//! while `cursor-agent --list-models` has the full matrix, so the model is
//! pinned with a launch flag instead of `session/set_model`.

use super::AcpModel;
use crate::shell;
use std::process::{Command, Stdio};

pub(super) fn cursor_cli_binary(program: Option<&str>) -> bool {
    matches!(program, Some("cursor-agent" | "agent"))
}

/// Insert `--model <id>` before the `acp` subcommand for Cursor's CLI.
pub(super) fn with_cursor_model_flag(mut tokens: Vec<String>, model: &str) -> Vec<String> {
    if model.is_empty() || !cursor_cli_binary(tokens.first().map(String::as_str)) {
        return tokens;
    }
    let Some(acp_at) = tokens.iter().position(|token| token == "acp") else {
        return tokens;
    };
    tokens.insert(acp_at, model.to_owned());
    tokens.insert(acp_at, "--model".into());
    tokens
}

/// Models from `cursor-agent --list-models` / `agent --list-models`.
/// Empty when the command is not Cursor's CLI or the flag is unavailable.
pub(super) fn cursor_cli_models(command: &str) -> Vec<AcpModel> {
    let Ok(tokens) = shell_words::split(command) else {
        return Vec::new();
    };
    let Some(program) = tokens.first() else {
        return Vec::new();
    };
    if !cursor_cli_binary(Some(program)) {
        return Vec::new();
    }
    // Same PATHEXT resolution the adapter launch needs — a CLI shipped as a
    // `.cmd` shim is invisible to `Command::new` on Windows.
    let launcher = shell::resolve_program(program);
    let mut cmd = Command::new(
        launcher
            .as_deref()
            .unwrap_or_else(|| std::path::Path::new(program)),
    );
    cmd.arg("--list-models")
        .env("PATH", shell::path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    shell::hide_console(&mut cmd);
    let Ok(output) = cmd.output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    parse_cursor_list_models(&String::from_utf8_lossy(&output.stdout))
}

/// Parse `cursor-agent --list-models` lines: `id - Display name`.
fn parse_cursor_list_models(text: &str) -> Vec<AcpModel> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.eq_ignore_ascii_case("Available models") {
                return None;
            }
            let (id, name) = line.split_once(" - ")?;
            let id = id.trim();
            let name = name.trim();
            if id.is_empty() {
                return None;
            }
            Some(AcpModel {
                id: id.to_owned(),
                name: if name.is_empty() {
                    id.to_owned()
                } else {
                    name.to_owned()
                },
                description: String::new(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cursor_list_models_lines() {
        let models = parse_cursor_list_models(
            "Available models\n\ncursor-grok-4.5-high - Cursor Grok 4.5\ncursor-grok-4.5-low - Cursor Grok 4.5 Low\n",
        );
        assert_eq!(
            models
                .iter()
                .map(|m| (m.id.as_str(), m.name.as_str()))
                .collect::<Vec<_>>(),
            [
                ("cursor-grok-4.5-high", "Cursor Grok 4.5"),
                ("cursor-grok-4.5-low", "Cursor Grok 4.5 Low"),
            ]
        );
    }

    #[test]
    fn injects_model_before_the_cursor_acp_subcommand() {
        assert_eq!(
            with_cursor_model_flag(
                vec!["cursor-agent".to_string(), "acp".to_string()],
                "cursor-grok-4.5-low"
            ),
            vec![
                "cursor-agent".to_string(),
                "--model".to_string(),
                "cursor-grok-4.5-low".to_string(),
                "acp".to_string(),
            ]
        );
        // Non-Cursor adapters keep their argv untouched.
        assert_eq!(
            with_cursor_model_flag(
                vec!["npx".to_string(), "-y".to_string(), "codex-acp".to_string()],
                "sol"
            ),
            vec!["npx".to_string(), "-y".to_string(), "codex-acp".to_string()]
        );
    }
}
