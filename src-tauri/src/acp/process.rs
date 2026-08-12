//! Spawning the adapter and living with its process: argv tokenizing, the
//! stderr drain, the turn watchdog, and reaping the child.

use super::cursor::{cursor_cli_binary, with_cursor_model_flag};
use super::progress::truncate_for_progress;
use super::{MAX_STDERR_BYTES, TIMEOUT};
use crate::shell;
use std::io::{BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Spawn the adapter, hand its stdio to `session`, then always stop it.
///
/// Both entry points need the same launch, watchdog, stderr-capture and reap
/// discipline; only the conversation differs. When `model` is non-empty and the
/// binary is Cursor's CLI, `--model` is inserted before the `acp` subcommand so
/// effort variants from `--list-models` actually take effect.
///
/// OpenCode's `acp` subcommand rejects launch `-m`/`--model` (prints help and
/// exits), so its pin stays on `session/set_config_option` inside [`run_session`].
/// Live stderr ERROR lines still stream through `progress` when provided.
pub(super) fn with_agent<T>(
    command: &str,
    cwd: &Path,
    model: &str,
    progress: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    session: impl FnOnce(
        BufReader<std::process::ChildStdout>,
        std::process::ChildStdin,
        bool,
    ) -> Result<T, String>,
) -> Result<T, String> {
    let tokens = shell_words::split(command)
        .map_err(|_| format!("Could not parse the agent command: {command}"))?;
    let launch_pinned = cursor_cli_binary(tokens.first().map(String::as_str)) && !model.is_empty();
    let tokens = with_cursor_model_flag(tokens, model);
    let (program, args) = tokens
        .split_first()
        .ok_or_else(|| "The agent command is empty.".to_string())?;
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        // GUI apps inherit a minimal PATH, so `npx`/`claude` would be invisible.
        .env("PATH", shell::path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    shell::hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            format!("`{program}` was not found. Install the ACP adapter for this agent (for example `npm i -g @agentclientprotocol/claude-agent-acp`), then try again.")
        } else {
            format!("Could not start the agent `{program}`: {error}")
        }
    })?;
    let stdin = child.stdin.take().ok_or("The agent has no stdin.")?;
    let stdout = child.stdout.take().ok_or("The agent has no stdout.")?;
    let stderr = child.stderr.take().ok_or("The agent has no stderr.")?;
    let errors = drain(stderr, progress);
    let child = Arc::new(Mutex::new(child));
    let finished = Arc::new(AtomicBool::new(false));
    watchdog(Arc::clone(&child), Arc::clone(&finished));
    let outcome = session(BufReader::new(stdout), stdin, launch_pinned);
    finished.store(true, Ordering::Relaxed);
    reap(&child);
    // The agent's own stderr is the only thing that can explain a crash before
    // it ever spoke protocol, so fold it into the failure.
    outcome.map_err(
        |error| match errors.lock().map(|buf| buf.trim().to_owned()) {
            Ok(details) if !details.is_empty() => format!("{error}\n\n{details}"),
            _ => error,
        },
    )
}

/// Read the child's stderr into a capped buffer on its own thread, so a full
/// pipe can never deadlock the protocol conversation on stdout. When `progress`
/// is set, ERROR lines (OpenCode `stream error`, …) also stream as live labels
/// so a quiet turn does not look hung while the provider is failing.
fn drain(
    mut stderr: impl Read + Send + 'static,
    progress: Option<Arc<dyn Fn(&str) + Send + Sync>>,
) -> Arc<Mutex<String>> {
    let buffer = Arc::new(Mutex::new(String::new()));
    let sink = Arc::clone(&buffer);
    std::thread::spawn(move || {
        let mut chunk = [0u8; 1024];
        let mut pending = String::new();
        while let Ok(read) = stderr.read(&mut chunk) {
            if read == 0 {
                break;
            }
            let text = String::from_utf8_lossy(&chunk[..read]);
            {
                let Ok(mut sink) = sink.lock() else { break };
                if sink.len() < MAX_STDERR_BYTES {
                    sink.push_str(&text);
                }
            }
            if let Some(ref progress) = progress {
                pending.push_str(&text);
                // A never-terminated stderr line would otherwise grow forever;
                // a label is truncated to a few dozen chars anyway.
                if pending.len() > MAX_STDERR_BYTES && !pending.contains('\n') {
                    pending.clear();
                }
                while let Some(at) = pending.find('\n') {
                    let line: String = pending.drain(..=at).collect();
                    if let Some(label) = stderr_progress_label(line.trim_end_matches(['\r', '\n']))
                    {
                        progress(&label);
                    }
                }
            }
        }
    });
    buffer
}

/// Turn one agent stderr line into a banner label. OpenCode logs
/// `level=ERROR … message="stream error" modelID=big-pickle`; other adapters
/// that print a clear `error:` line also qualify. Skill-duplicate WARNs do not.
fn stderr_progress_label(line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() || !line.to_ascii_lowercase().contains("level=error") {
        return None;
    }
    let message = log_field(line, "message").unwrap_or_else(|| "agent error".to_owned());
    let model = log_field(line, "modelID");
    let provider = log_field(line, "providerID");
    let detail = match (provider.as_deref(), model.as_deref()) {
        (Some(provider), Some(model)) => format!("{message} ({provider}/{model})"),
        (_, Some(model)) => format!("{message} ({model})"),
        _ => message,
    };
    Some(format!("Error · {}", truncate_for_progress(&detail, 56)))
}

/// `key=value` or `key="quoted value"` from an OpenCode-style log line.
fn log_field(line: &str, key: &str) -> Option<String> {
    let marker = format!("{key}=");
    let rest = line.split(&marker).nth(1)?;
    if let Some(stripped) = rest.strip_prefix('"') {
        let end = stripped.find('"')?;
        return Some(stripped[..end].to_owned());
    }
    let end = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
    let value = rest[..end].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_owned())
    }
}

/// Kill the agent if the turn outlives [`TIMEOUT`]. Killing it closes stdout,
/// which ends the read loop with "exited before answering" — no separate
/// cancellation path needed.
fn watchdog(child: Arc<Mutex<Child>>, finished: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let tick = Duration::from_millis(250);
        let mut waited = Duration::ZERO;
        while waited < TIMEOUT {
            if finished.load(Ordering::Relaxed) {
                return;
            }
            std::thread::sleep(tick);
            waited += tick;
        }
        if !finished.load(Ordering::Relaxed) {
            reap(&child);
        }
    });
}

/// Stop the agent and collect it, so a finished turn never leaves a zombie or a
/// stray adapter process behind.
fn reap(child: &Arc<Mutex<Child>>) {
    if let Ok(mut child) = child.lock() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stderr_progress_label_surfaces_opencode_stream_errors() {
        assert_eq!(
            stderr_progress_label(
                r#"timestamp=2026-08-12T08:51:03.158Z level=ERROR run=b68917f7 message="stream error" providerID=opencode modelID=big-pickle session.id=ses_1 small=true agent=title"#
            )
            .as_deref(),
            Some("Error · stream error (opencode/big-pickle)")
        );
        // Duplicate skill WARNs must not spam the banner.
        assert_eq!(
            stderr_progress_label(
                r#"timestamp=2026-08-12T08:51:03.158Z level=WARN message="duplicate skill name" name=research"#
            ),
            None
        );
        assert_eq!(stderr_progress_label(""), None);
    }
}
