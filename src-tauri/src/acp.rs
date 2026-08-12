//! A minimal client for the Agent Client Protocol (ACP) — newline-delimited
//! JSON-RPC over a spawned agent's stdio.
//!
//! Every in-app agent action (draft a commit message, describe a change) runs
//! through here. It replaced a file-mailbox handoff — a prose contract asking
//! the agent to write a temp file under `.git/` that GitLane then polled for —
//! which is why failures are now legible: a missing adapter, an auth error, or
//! a refusal each say so, where the mailbox could only ever time out.
//! Terminal-launched agents still exist, but they hand off work rather than
//! answering: nothing comes back from a PTY.
//!
//! The agent runs as the user's own already-authenticated CLI (via an adapter
//! such as `npx @agentclientprotocol/claude-agent-acp`), so a Claude Pro/Max
//! subscription works with no API key. `ANTHROPIC_API_KEY` is deliberately
//! never set here: its presence makes Claude Code bill the API instead.
//!
//! Deliberately hand-rolled rather than built on the `agent-client-protocol`
//! crate — that SDK is async, and this codebase has no runtime beyond Tauri's
//! (the same reasoning that picked the blocking `ureq` for provider OAuth).
//! Only one turn of the protocol is implemented: one prompt in, one text out.
//! Tool-call titles stream back as `acp-progress` events so the UI can show
//! what the agent is doing while it works; the answer itself still arrives
//! whole when the turn ends.
//!
//! This file is the facade: the shared types every submodule reads, the tuning
//! constants, and the two entry points (`prompt`, `probe`). The turn itself
//! lives in `acp/`.
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

mod answer;
mod catalogue;
mod cursor;
mod process;
mod progress;
mod session;
mod wire;

pub use catalogue::catalog;
pub use process::cancel;

use cursor::cursor_cli_models;
use process::with_agent;
use session::{probe_session, run_session};

/// ACP versions are a single integer naming the MAJOR version.
const PROTOCOL_VERSION: u64 = 1;
/// Hard cap on one newline-delimited JSON-RPC frame from the adapter. An
/// unterminated or hostile line must not grow the buffer without bound.
const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
/// Give-up bound for a whole turn, matching the change-description ceiling the
/// frontend already used for the mailbox poll. Not a target — a hung agent must
/// not hold a blocking-pool thread forever.
const TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Enough of the agent's stderr to explain a startup failure, capped so a
/// chatty adapter cannot grow the buffer without bound.
const MAX_STDERR_BYTES: usize = 8 * 1024;
/// Cap on the assembled answer. Each frame is already bounded, but a turn is
/// many frames — an agent that never stops chunking must not grow this without
/// bound. Far above any commit message or change description.
const MAX_ANSWER_BYTES: usize = 1024 * 1024;
/// Tool-call kinds Draft / Describe may auto-approve on the kind alone. This
/// client has no permission UI, so anything that leaves the machine or changes
/// it fails closed: `edit`/`delete`/`move` are rejected outright, and `fetch`
/// is too — a turn that can reach the network can also carry the staged diff
/// off it. `execute` is not here either; it is allowed only for the read-only
/// git commands in [`ALLOWED_EXECUTE_GIT`], since the kind alone says nothing
/// about what would run.
const AUTO_ALLOW_TOOL_KINDS: &[&str] = &["read", "search", "think"];
/// Git subcommands an `execute` tool call may run unattended. The shipped
/// instructions ask for `git diff --staged`; the rest are the neighbours an
/// agent reaches for to read the same state. Every one of them only reads —
/// `commit`, `add`, `checkout` and friends are deliberately absent, and the
/// in-app commit flow never needs them (agent-driven commits go through the
/// terminal, not ACP).
const ALLOWED_EXECUTE_GIT: &[&str] = &[
    "diff",
    "show",
    "status",
    "log",
    "blame",
    "describe",
    "rev-parse",
    "ls-files",
];

/// Run one ACP turn against the agent launched by `command` and return the
/// agent's message text. A non-empty `model` pins the session to that model id
/// (adapter-defined, e.g. `gpt-5.6-sol[low]`) before prompting. Non-empty
/// entries in `config` pin other session config options (effort, fast, …)
/// via `session/set_config_option`. For Cursor's CLI, the model is also passed
/// as `--model` at launch — ACP only advertises one effort preset per model,
/// while `cursor-agent --list-models` has the full matrix.
///
/// `command` is a full command line (e.g. `npx @agentclientprotocol/claude-agent-acp`)
/// tokenized with shell quoting rules but **never** interpreted by a shell.
///
/// `progress` receives short human labels (tool titles, "Writing the answer…",
/// and agent stderr errors like OpenCode `stream error`) as the turn runs —
/// the UI listens for the matching Tauri event.
///
/// `run_id` tags those ticks *and* registers the child, so [`cancel`] can end
/// this exact turn when the user stops waiting.
pub fn prompt(
    command: &str,
    cwd: &Path,
    model: &str,
    config: &BTreeMap<String, String>,
    text: &str,
    run_id: &str,
    progress: Arc<dyn Fn(&str) + Send + Sync>,
) -> Result<String, String> {
    with_agent(
        command,
        cwd,
        model,
        run_id,
        Some(Arc::clone(&progress)),
        |reader, writer, launch_pinned| {
            run_session(
                reader,
                writer,
                cwd,
                model,
                config,
                text,
                launch_pinned,
                progress.as_ref(),
            )
        },
    )
}

/// Payload of the `acp-progress` event streamed during [`prompt`].
/// `run_id` correlates the tick with the frontend call that started the turn
/// (Draft and Describe can run at the same time on the Changes tab).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpProgress {
    pub run_id: String,
    pub message: String,
}

/// What an adapter says about itself: its name and version from `initialize`,
/// and the models it offers from `session/new`. Doubles as the install/health
/// check — an adapter that answers this is present, launchable, and
/// authenticated, and one that doesn't returns the reason why.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpProbe {
    pub agent_name: String,
    pub agent_version: String,
    /// Empty when the adapter exposes no model selection — not an error, just
    /// nothing to choose. Prefer `configOptions` category `model` when the
    /// adapter advertises it (Codex now does, with a separate thought_level);
    /// fall back to `models.availableModels` for adapters that only have that.
    pub models: Vec<AcpModel>,
    pub current_model_id: String,
    /// Select options beside the model list that Settings should expose —
    /// ACP `thought_level` (effort) and `model_config` (e.g. Fast mode).
    /// Empty when the adapter offers none.
    pub config_options: Vec<AcpConfigOption>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpModel {
    pub id: String,
    pub name: String,
    pub description: String,
}

/// A session config option other than the model selector (effort, fast, …).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpConfigOption {
    pub id: String,
    pub name: String,
    pub category: String,
    pub current_value: String,
    pub options: Vec<AcpModel>,
}

/// An ACP adapter GitLane knows how to launch, for the Settings picker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAdapter {
    pub id: String,
    pub name: String,
    /// What to put in an agent's ACP command.
    pub command: String,
    /// Optional global install of the *adapter*, shown as a copyable hint.
    /// `npx -y` already fetches on demand, so this only buys a faster first
    /// run. Empty for agents whose CLI speaks ACP itself — there is no adapter
    /// to install, only the CLI, which [`Self::docs`] points at.
    pub install: String,
    /// Where to get the underlying CLI. Shown as a link when a probe fails,
    /// which is the moment "how do I install this?" is the actual question.
    pub docs: String,
    /// What the adapter drives, and therefore whose login it uses.
    pub requires: String,
    /// True when this adapter's executable resolves on PATH. A pure filesystem
    /// lookup — no process is started — so the catalogue can show readiness on
    /// sight instead of making the user press "Check" on every row. Only the
    /// model list needs a real launch. Computed per read, never stored.
    #[serde(default)]
    pub available: bool,
}

/// Ask an adapter what it is and which models it offers, without prompting it.
/// Cheap enough to run from Settings: it opens a session and drops it.
pub fn probe(command: &str, cwd: &Path) -> Result<AcpProbe, String> {
    // No run id: a probe is not a turn the user can stop, and the watchdog
    // bounds it anyway.
    let mut probe = with_agent(command, cwd, "", "", None, |reader, writer, _| {
        probe_session(reader, writer, cwd)
    })?;
    // Cursor's ACP session only advertises one effort/fast preset per model.
    // The CLI's `--list-models` has the full matrix (low/medium/high × fast) —
    // prefer that when available so Settings can actually change effort.
    let cli_models = cursor_cli_models(command);
    if !cli_models.is_empty() {
        probe.models = cli_models;
    }
    Ok(probe)
}
