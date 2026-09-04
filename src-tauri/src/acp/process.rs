//! Spawning the adapter and living with its process: argv tokenizing, the
//! stderr drain, the turn watchdog, and reaping the child.

use super::cursor::{cursor_cli_binary, with_cursor_model_flag};
use super::progress::truncate_for_progress;
use super::{ProgressSink, MAX_STDERR_BYTES, TIMEOUT};
use crate::shell;
use std::collections::BTreeMap;
use std::io::{BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// Children of in-flight turns, keyed by the run id the frontend passed to
/// `acp_prompt`. Stop used to clear the banner and leave the adapter running —
/// invisible, still able to call tools, and holding a blocking-pool thread
/// until the five-minute watchdog. Registering the child here is what lets
/// [`cancel`] actually end it.
static RUNNING: OnceLock<Mutex<BTreeMap<String, Arc<Mutex<Child>>>>> = OnceLock::new();

fn running() -> &'static Mutex<BTreeMap<String, Arc<Mutex<Child>>>> {
    RUNNING.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// Stop the turn `run_id` started, if it is still going. Returns whether there
/// was one — a Stop that arrives after the answer is not an error.
pub fn cancel(run_id: &str) -> bool {
    let child = running()
        .lock()
        .ok()
        .and_then(|mut runs| runs.remove(run_id));
    match child {
        Some(child) => {
            reap(&child);
            true
        }
        None => false,
    }
}

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
    run_id: &str,
    progress: Option<ProgressSink>,
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
    // Windows: `Command` only ever appends `.exe`, so the `npx.cmd` npm installs
    // is invisible to it and every `npx -y @…-acp` adapter failed "not found" on
    // a machine where npx works in every shell. Resolving through PATHEXT first
    // hands it a file it can actually spawn.
    let launcher = shell::resolve_program(program);
    let mut cmd = Command::new(launcher.as_deref().unwrap_or_else(|| Path::new(program)));
    cmd.args(args)
        .current_dir(cwd)
        // GUI apps inherit a minimal PATH, so `npx`/`claude` would be invisible.
        .env("PATH", shell::path())
        // The point of running the user's own signed-in CLI is that their
        // subscription pays for the turn. An inherited key silently flips
        // Claude Code onto metered API billing, so it does not reach the child.
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("ANTHROPIC_AUTH_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    shell::hide_console(&mut cmd);
    // Own the whole tree: `npx -y @scope/adapter` is a launcher whose real agent
    // is a grandchild, and killing only the launcher would orphan it. A process
    // group makes one signal reach all of them.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd
        .spawn()
        .map_err(|error| launch_failure(command, program, &error))?;
    let stdin = child.stdin.take().ok_or("The agent has no stdin.")?;
    let stdout = child.stdout.take().ok_or("The agent has no stdout.")?;
    let stderr = child.stderr.take().ok_or("The agent has no stderr.")?;
    let errors = drain(stderr, progress);
    let child = Arc::new(Mutex::new(child));
    let finished = Arc::new(AtomicBool::new(false));
    watchdog(Arc::clone(&child), Arc::clone(&finished));
    if !run_id.is_empty() {
        if let Ok(mut runs) = running().lock() {
            runs.insert(run_id.to_owned(), Arc::clone(&child));
        }
    }
    let outcome = session(BufReader::new(stdout), stdin, launch_pinned);
    finished.store(true, Ordering::Relaxed);
    if !run_id.is_empty() {
        if let Ok(mut runs) = running().lock() {
            runs.remove(run_id);
        }
    }
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

/// Package runners that fetch the real adapter at launch. `npx -y <pkg>` never
/// needs the adapter installed, so "not found" for one of these means the
/// toolchain behind it is missing — telling the user to `npm i -g …` when npm
/// itself is absent is the advice this list exists to avoid. The frontend keeps
/// its own copy in `src/features/agents/acpFields.ts`, where it decides whether
/// a launcher on PATH is evidence of anything.
const PACKAGE_RUNNERS: &[(&str, &str)] = &[
    ("npx", "Node.js"),
    ("npm", "Node.js"),
    ("pnpx", "pnpm"),
    ("pnpm", "pnpm"),
    ("yarn", "Yarn"),
    ("bunx", "Bun"),
    ("bun", "Bun"),
    ("uvx", "uv"),
    ("uv", "uv"),
    ("deno", "Deno"),
];

/// The toolchain a package runner ships with, if `program` is one. Matching is
/// on the file name, so `C:\…\npx.cmd` and a bare `npx` answer the same.
fn package_runner_toolchain(program: &str) -> Option<&'static str> {
    let file = Path::new(program)
        .file_stem()
        .and_then(|stem| stem.to_str())?
        .to_ascii_lowercase();
    PACKAGE_RUNNERS
        .iter()
        .find(|(runner, _)| *runner == file)
        .map(|(_, toolchain)| *toolchain)
}

/// Why the adapter did not start, in terms the user can act on. A missing
/// binary is the common case and deserves the exact next step: install the
/// toolchain when the launcher itself is absent, otherwise the catalogue's own
/// install command for this adapter — not an example for a different one.
fn launch_failure(command: &str, program: &str, error: &std::io::Error) -> String {
    if error.kind() != std::io::ErrorKind::NotFound {
        return format!("Could not start the agent `{program}`: {error}");
    }
    if let Some(toolchain) = package_runner_toolchain(program) {
        return format!(
            "`{program}` was not found on PATH. It comes with {toolchain} — install that, then restart GitLane (PATH is read once at launch)."
        );
    }
    match super::catalogue::install_for(command) {
        Some(install) => format!(
            "`{program}` was not found on PATH. Install this adapter with `{install}`, then restart GitLane (PATH is read once at launch)."
        ),
        None => format!(
            "`{program}` was not found on PATH. Install the CLI this adapter drives, then restart GitLane (PATH is read once at launch)."
        ),
    }
}

/// Read the child's stderr into a capped buffer on its own thread, so a full
/// pipe can never deadlock the protocol conversation on stdout. When `progress`
/// is set, ERROR lines (OpenCode `stream error`, …) also stream as live labels
/// so a quiet turn does not look hung while the provider is failing.
fn drain(
    mut stderr: impl Read + Send + 'static,
    progress: Option<ProgressSink>,
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
        kill_group(child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Signal the child's whole process group (see the `process_group` call in
/// [`with_agent`]). `Child::kill` only reaches the launcher, which on
/// `npx`-based adapters is not the agent.
#[cfg(unix)]
fn kill_group(pid: u32) {
    // ponytail: shells out to `kill` rather than taking a `libc` dependency for
    // one `killpg`. Swap it for `libc::killpg` if this tree ever needs libc.
    let mut kill = Command::new("kill");
    kill.arg("-TERM").arg(format!("-{pid}"));
    shell::hide_console(&mut kill);
    let _ = kill.stderr(Stdio::null()).status();
}

#[cfg(not(unix))]
fn kill_group(_pid: u32) {
    // Windows has no process groups here — `Child::kill` on the launcher is all
    // this does, matching the behaviour before process groups existed.
}

#[cfg(test)]
mod tests {

    /// A Stop that arrives after the answer already landed has no child to
    /// kill. It must report "there was nothing running" rather than panic or
    /// invent a cancellation.
    #[test]
    fn cancelling_a_run_that_is_not_running_reports_false() {
        assert!(!cancel("no-such-run-id"));
        assert!(!cancel(""));
    }

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

    fn not_found() -> std::io::Error {
        std::io::Error::new(std::io::ErrorKind::NotFound, "program not found")
    }

    #[test]
    fn a_missing_package_runner_blames_its_toolchain_not_the_adapter() {
        // `npm i -g <adapter>` is useless advice when npm is the thing missing,
        // and `npx -y` never needed the adapter installed in the first place.
        let message = launch_failure("npx -y @agentclientprotocol/codex-acp", "npx", &not_found());
        assert!(message.contains("Node.js"), "{message}");
        assert!(!message.contains("npm i -g"), "{message}");
        // A resolved launcher path answers the same as the bare name. Each form
        // is asserted where it actually parses as a path: `\` is a separator
        // only on Windows, so the `C:\…` case reads as one long filename
        // everywhere else.
        #[cfg(windows)]
        assert_eq!(
            package_runner_toolchain(r"C:\nodejs\npx.cmd"),
            Some("Node.js")
        );
        #[cfg(not(windows))]
        assert_eq!(
            package_runner_toolchain("/usr/local/bin/npx"),
            Some("Node.js")
        );
        assert_eq!(package_runner_toolchain("cursor-agent"), None);
    }

    #[test]
    fn a_missing_adapter_names_its_own_install_command() {
        // The old message pointed every adapter at the Claude one.
        let message = launch_failure("copilot --acp", "copilot", &not_found());
        assert!(message.contains("npm i -g @github/copilot"), "{message}");
        assert!(
            !message.contains("claude-agent-acp"),
            "the hint must be this adapter's: {message}"
        );

        // A catalogue entry with no install command still says something useful.
        let message = launch_failure("cursor-agent acp", "cursor-agent", &not_found());
        assert!(message.contains("Install the CLI"), "{message}");
    }

    #[test]
    fn a_failure_that_is_not_a_missing_binary_reports_itself() {
        let denied = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let message = launch_failure("kimi acp", "kimi", &denied);
        assert!(
            message.starts_with("Could not start the agent `kimi`"),
            "{message}"
        );
    }
}
