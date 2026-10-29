//! Running a command on the agent's host: the table's commands, the two
//! progress-streaming worktree commands, and the watch (remote-ssh-repos D6,
//! D10). Compiled into the agent binary and tests only; the desktop forwards
//! commands and never runs them here.

use std::sync::{Arc, LazyLock};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use super::dispatch::{run_table, without_accounts};
use crate::commands::{blocking, CommandError};
use crate::events::{self, DeleteWorktreeProgressEvent, HandoffProgressEvent, RepoChangedEvent};
use crate::git;
use crate::git::types::CommandErrorKind;
use crate::watcher::{self, OnChange, WatcherState};

/// Where a progress-streaming command sends each step: a declared event name
/// from [`crate::events`] and its payload. The agent turns these into event
/// frames and the desktop re-emits them to the webview.
pub type Progress = Arc<dyn Fn(&'static str, Value) + Send + Sync>;

/// The agent process's watches: one registry for every repository it serves.
static WATCHES: LazyLock<WatcherState> = LazyLock::new(WatcherState::default);

/// Read one argument the way Tauri does: under the parameter's camelCase name,
/// with a missing key read as `null` so `Option` parameters default to `None`.
pub(super) fn arg<T: DeserializeOwned>(args: &Value, param: &str) -> Result<T, CommandError> {
    let key = camel(param);
    let value = args.get(&key).cloned().unwrap_or(Value::Null);
    serde_json::from_value(value)
        .map_err(|e| CommandError::internal(format!("Invalid argument `{key}`: {e}")))
}

pub(super) fn camel(param: &str) -> String {
    let mut out = String::with_capacity(param.len());
    let mut upper = false;
    for c in param.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

pub(super) fn to_json<T: Serialize>(value: T) -> Result<Value, CommandError> {
    serde_json::to_value(value)
        .map_err(|e| CommandError::internal(format!("Unserializable response: {e}")))
}

/// Run `command` for a repository on this host. Progress-streaming commands
/// report through `progress`; anything not remote-capable is refused.
pub async fn dispatch(
    command: &str,
    args: &Value,
    progress: Progress,
) -> Result<Value, CommandError> {
    let args = &without_accounts(args);
    if let Some(result) = run_table(command, args).await {
        return result;
    }
    match command {
        "move_branch_to_worktree" => {
            let (path, branch, from, to, carry): (String, String, String, String, bool) = (
                arg(args, "path")?,
                arg(args, "branch")?,
                arg(args, "from_worktree_path")?,
                arg(args, "to_worktree_path")?,
                arg(args, "carry")?,
            );
            to_json(
                blocking(move || {
                    git::write::worktrees::move_branch_to_worktree(
                        &path,
                        &branch,
                        &from,
                        &to,
                        carry,
                        &|step| {
                            let event = HandoffProgressEvent {
                                step: step.to_string(),
                            };
                            progress(events::HANDOFF_PROGRESS, serde_json::json!(event));
                        },
                    )
                })
                .await?,
            )
        }
        "delete_branch_with_worktree" => {
            let (path, branch, from, oid, state): (String, String, String, String, String) = (
                arg(args, "path")?,
                arg(args, "branch")?,
                arg(args, "from_worktree_path")?,
                arg(args, "expected_oid")?,
                arg(args, "expected_state")?,
            );
            to_json(
                blocking(move || {
                    git::write::worktrees::delete_branch_with_worktree(
                        &path,
                        &branch,
                        &from,
                        &oid,
                        &state,
                        &|step| {
                            let event = DeleteWorktreeProgressEvent {
                                step: step.to_string(),
                            };
                            progress(events::DELETE_WORKTREE_PROGRESS, serde_json::json!(event));
                        },
                    )
                })
                .await?,
            )
        }
        "watch_repo" => {
            let path: String = arg(args, "path")?;
            let on_change: OnChange = Arc::new(move |kind, key| {
                let event = RepoChangedEvent {
                    kind,
                    path: key.to_string(),
                };
                progress(events::REPO_CHANGED, serde_json::json!(event));
            });
            to_json(blocking(move || watcher::watch(on_change, &WATCHES, &path)).await?)
        }
        "unwatch_repo" => {
            let path: String = arg(args, "path")?;
            to_json(blocking(move || watcher::unwatch(&WATCHES, &path)).await?)
        }
        _ => Err(CommandError::new(
            CommandErrorKind::UnsupportedOnRemote,
            format!("`{command}` is not available for remote repositories."),
        )),
    }
}
