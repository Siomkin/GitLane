//! Spawning the adapter and living with its process: argv tokenizing, the
//! stderr drain, the turn watchdog, and reaping the child.

use super::cursor::{cursor_cli_binary, with_cursor_model_flag};
use super::progress::truncate_for_progress;
use super::{ProgressSink, MAX_STDERR_BYTES, TIMEOUT};
use crate::shell::{self, reap, watchdog, ChildSlot};
use std::collections::BTreeMap;
use std::io::{BufReader, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

/// In-flight turns, keyed by the run id the frontend passed to `acp_prompt`.
/// Stop used to clear the banner and leave the adapter running — invisible,
/// still able to call tools, and holding a blocking-pool thread until the
/// five-minute watchdog. Registering the run here is what lets [`cancel`]
/// actually end it.
static RUNNING: OnceLock<Mutex<BTreeMap<String, Run>>> = OnceLock::new();

/// What a Stop finds for a run id.
enum Run {
    /// Recorded by [`arm`] before the turn waits for the blocking pool, so a
    /// Stop that lands before the spawn is kept rather than dropped.
    Pending { stopped: bool },
    /// The adapter is running; a Stop reaps it.
    Live(ChildSlot),
}

/// What an early Stop turns the turn into.
const STOPPED: &str = "Agent run stopped.";

fn runs() -> MutexGuard<'static, BTreeMap<String, Run>> {
    RUNNING
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Record `run_id` as pending until its turn ends, which is when the returned
/// guard drops. An empty id is never recorded. Run ids are unique per turn;
/// re-arming one still in flight would replace its entry.
pub fn arm(run_id: &str) -> RunGuard {
    if !run_id.is_empty() {
        runs().insert(run_id.to_owned(), Run::Pending { stopped: false });
    }
    RunGuard(run_id.to_owned())
}

/// Removes its run's entry when the turn ends, by any path.
pub struct RunGuard(String);

impl Drop for RunGuard {
    fn drop(&mut self) {
        if !self.0.is_empty() {
            runs().remove(&self.0);
        }
    }
}

/// Stop the turn `run_id` started, if it is still going. Returns whether there
/// was one — a Stop that arrives after the answer is not an error. A turn that
/// has not spawned yet is marked, and will not start (see [`with_agent`]).
pub fn cancel(run_id: &str) -> bool {
    let child = {
        let mut runs = runs();
        match runs.get_mut(run_id) {
            Some(Run::Pending { stopped }) => {
                *stopped = true;
                return true;
            }
            Some(Run::Live(_)) => match runs.remove(run_id) {
                Some(Run::Live(child)) => child,
                _ => return false,
            },
            None => return false,
        }
    };
    // Outside the map lock: reaping waits for the child.
    reap(&child);
    true
}

fn stopped(run_id: &str) -> bool {
    matches!(runs().get(run_id), Some(Run::Pending { stopped: true }))
}

/// Make the run live with `child`. `false` when a Stop landed while it was
/// spawning, in which case the caller ends the child.
fn register(run_id: &str, child: &ChildSlot) -> bool {
    if run_id.is_empty() {
        return true;
    }
    let mut runs = runs();
    if matches!(runs.get(run_id), Some(Run::Pending { stopped: true })) {
        return false;
    }
    runs.insert(run_id.to_owned(), Run::Live(Arc::clone(child)));
    true
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
    let (env, tokens) = split_env_prefix(tokens);
    let launch_pinned = cursor_cli_binary(tokens.first().map(String::as_str)) && !model.is_empty();
    let tokens = with_cursor_model_flag(tokens, model);
    let (program, args) = tokens
        .split_first()
        .ok_or_else(|| "The agent command is empty.".to_string())?;
    // Windows: `Command` only ever appends `.exe`, so the `npx.cmd` npm installs
    // is invisible to it and every `npx -y @…-acp` adapter failed "not found" on
    // a machine where npx works in every shell. Resolving through PATHEXT first
    // hands it a file it can actually spawn.
    let path = shell::path();
    let launcher = shell::resolve_program(program, &path);
    let mut cmd = Command::new(launcher.as_deref().unwrap_or_else(|| Path::new(program)));
    cmd.args(args)
        .current_dir(launch_dir(command, cwd))
        // GUI apps inherit a minimal PATH, so `npx`/`claude` would be invisible.
        .env("PATH", path)
        // The point of running the user's own signed-in CLI is that their
        // subscription pays for the turn. An inherited key silently flips
        // Claude Code onto metered API billing, so it does not reach the child.
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("ANTHROPIC_AUTH_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Last, so a variable the user spelled out wins over the defaults above.
        .envs(env);
    shell::hide_console(&mut cmd);
    // Own the whole tree: `npx -y @scope/adapter` is a launcher whose real agent
    // is a grandchild, and killing only the launcher would orphan it. A process
    // group makes one signal reach all of them.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    if stopped(run_id) {
        return Err(STOPPED.to_owned());
    }
    let mut child = cmd
        .spawn()
        .map_err(|error| launch_failure(command, program, &error))?;
    let stdin = child.stdin.take().ok_or("The agent has no stdin.")?;
    let stdout = child.stdout.take().ok_or("The agent has no stdout.")?;
    let stderr = child.stderr.take().ok_or("The agent has no stderr.")?;
    let errors = drain(stderr, progress);
    let child: ChildSlot = Arc::new(Mutex::new(Some(child)));
    if !register(run_id, &child) {
        reap(&child);
        return Err(STOPPED.to_owned());
    }
    let finished = Arc::new(AtomicBool::new(false));
    watchdog(Arc::clone(&child), Arc::clone(&finished), TIMEOUT);
    let outcome = session(BufReader::new(stdout), stdin, launch_pinned);
    finished.store(true, Ordering::Relaxed);
    if !run_id.is_empty() {
        runs().remove(run_id);
    }
    // After a Stop, `cancel` already reaped it and this finds the slot empty.
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

/// Split leading `NAME=value` tokens (`FOO=bar claude …`) off as the child's
/// environment; the rest is argv. The PATH probe skips the same prefix, so a
/// command it reports available is one this can actually spawn.
fn split_env_prefix(mut tokens: Vec<String>) -> (Vec<(String, String)>, Vec<String>) {
    let program_at = tokens
        .iter()
        .position(|token| !shell::is_env_assignment(token))
        .unwrap_or(tokens.len());
    let argv = tokens.split_off(program_at);
    let env = tokens
        .into_iter()
        .filter_map(|token| {
            let (name, value) = token.split_once('=')?;
            Some((name.to_owned(), value.to_owned()))
        })
        .collect();
    (env, argv)
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

/// Where to spawn the adapter. A catalogue `npx` adapter started inside the repo
/// reads the repo's `package.json` and `.npmrc` first, so a manifest npm rejects
/// (an `EOVERRIDE`) killed the agent before it ran. It learns the repo from
/// `session/new`'s `cwd`, so it starts in the user's home instead — not the temp
/// dir, which is shared `/tmp` on Linux, where another user could plant an
/// `.npmrc` that npm would read. Custom commands keep the repo: they may name
/// repo-relative paths, a devDependency adapter, or read `process.cwd()`.
fn launch_dir(command: &str, cwd: &Path) -> std::path::PathBuf {
    match std::env::home_dir() {
        Some(home) if home.is_dir() && super::catalogue::is_npx_adapter(command) => home,
        _ => cwd.to_path_buf(),
    }
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

#[cfg(test)]
mod tests;
