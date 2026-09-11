//! Constructing the centralized `git` subprocess.

use std::io;
use std::process::{Command, Output, Stdio};

use super::version::ensure_supported_git;
use crate::git::tool_probes::TOOL_PROBES;
use crate::git::{clear_repository_local_env, isolated_git_command};

/// The one conversion for a failed `git` spawn. `NotFound` means the binary the
/// version gate vouched for is gone (uninstalled, PATH changed), so its cached
/// probe is dropped and the next call re-checks instead of trusting a stale
/// success. One invalidation per failure; nothing re-probes from here.
pub(in crate::git::write) fn launch_error(error: io::Error) -> String {
    if error.kind() == io::ErrorKind::NotFound {
        TOOL_PROBES.git.invalidate();
    }
    format!("failed to launch git: {error}")
}

// Stops git's own HTTPS username/password prompts from blocking the app/dev
// terminal. SSH and external askpass helpers have their own prompting paths.
const GIT_TERMINAL_PROMPT_DISABLED: &str = "0";

/// The identity git reads from the environment, which **outranks** the
/// `-c user.name=…`/`-c user.email=…` a pinned identity card is applied with.
/// If GitLane is launched from a shell that exports any of these — a Windows
/// user-level variable, a `.profile` that sets one, `bun run tauri dev` from
/// such a shell — the card silently stops deciding who authors the commit, and
/// the author guard still passes because it checks the card, not the result.
///
/// These are cleared in [`git_command`]/[`git_command_bare`] and deliberately
/// **not** in `clear_repository_local_env`: `git_output` re-applies that list
/// *after* the caller's own `envs`, which would wipe the explicit
/// `GIT_AUTHOR_*` pins the squash replay uses to preserve each replayed
/// commit's original author.
pub(in crate::git::write) const COMMIT_IDENTITY_ENV_VARS: &[&str] = &[
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_DATE",
];

fn clear_inherited_identity(command: &mut Command) {
    for key in COMMIT_IDENTITY_ENV_VARS {
        command.env_remove(key);
    }
}

/// Pin the language git reports in, so classifying a failure and detecting an
/// outcome never depend on the user's locale. GitLane's own interface is
/// English-only, and `write/classify.rs` matches git's wording to decide
/// whether a failure was a conflict, an auth problem, or a stranded lock.
///
/// Only the message category is pinned. `LC_ALL` would also force the ctype on
/// everything git runs — hooks included — and a hook is an arbitrary program
/// that may read non-ASCII content under the user's own encoding. `LC_ALL` and
/// `LANGUAGE` both outrank `LC_MESSAGES`, so they have to go for this to hold.
fn pin_message_locale(command: &mut Command) {
    command.env_remove("LC_ALL");
    command.env_remove("LANGUAGE");
    command.env("LC_MESSAGES", "C");
}

pub(super) fn git_output(
    repo: &str,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<Output, String> {
    let mut cmd = git_command(repo)?;
    cmd.args(args);
    // GitLane must surface missing credentials through IPC instead of letting
    // git block the dev/app terminal with an invisible password prompt.
    cmd.stdin(Stdio::null());
    for (k, v) in envs {
        cmd.env(k, v);
    }
    // Keep the repository argument authoritative even if a future caller
    // accidentally forwards one of Git's process-global routing variables.
    clear_repository_local_env(&mut cmd);

    cmd.output().map_err(launch_error)
}

pub(in crate::git::write) fn git_command(repo: &str) -> Result<Command, String> {
    ensure_supported_git()?;
    let mut cmd = isolated_git_command();
    cmd.arg("-C").arg(repo);
    // `log.showSignature` makes every `git log` verify signatures and print the
    // verdict to stdout, ahead of the record the `--format` asked for. GitLane
    // parses that output (recovery points, operation previews, the squash
    // replay), so the verdict lines would be read as records. Passed as an
    // argument rather than folded into the caller's args, which name the
    // operation in the "git … failed" fallback.
    cmd.arg("-c").arg("log.showSignature=false");
    // macOS GUI apps launch with a minimal PATH; use the augmented one so a
    // Homebrew git (and any credential helpers/signing tools it invokes) is found.
    cmd.env("PATH", crate::shell::path());
    cmd.env("GIT_TERMINAL_PROMPT", GIT_TERMINAL_PROMPT_DISABLED);
    clear_repository_local_env(&mut cmd);
    clear_inherited_identity(&mut cmd);
    pin_message_locale(&mut cmd);
    crate::shell::hide_console(&mut cmd);
    Ok(cmd)
}

/// Build a `git <args>` command **without** `-C <repo>` (PATH augmented like
/// [`run_git`]), for operations that act outside an existing repository
/// (clone/init). Callers needing custom stdio/streaming — the clone progress
/// reader — build on this so git subprocess construction stays centralized here;
/// most callers use the buffered [`run_git_bare`].
pub(in crate::git::write) fn git_command_bare(args: &[&str]) -> Result<Command, String> {
    ensure_supported_git()?;
    let mut cmd = isolated_git_command();
    cmd.args(args)
        .env("PATH", crate::shell::path())
        .env("GIT_TERMINAL_PROMPT", GIT_TERMINAL_PROMPT_DISABLED)
        .stdin(Stdio::null());
    clear_repository_local_env(&mut cmd);
    clear_inherited_identity(&mut cmd);
    pin_message_locale(&mut cmd);
    crate::shell::hide_console(&mut cmd);
    Ok(cmd)
}
