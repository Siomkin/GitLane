//! The commands served for a remote repository (remote-ssh-repos D6).
//!
//! The table below is the one list of remote-capable commands. The desktop uses
//! its names to reject anything else before contacting a server; the agent uses
//! it to run the same `commands::*` function the desktop runs, so defaults and
//! argument handling never drift between the two. Every other registered
//! command is local-only (`registration_tests/remote_split.rs` holds that list
//! and fails when a command is in neither).

use std::sync::{Arc, LazyLock};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::commands::{self, blocking, CommandError};
use crate::events::{self, DeleteWorktreeProgressEvent, HandoffProgressEvent, RepoChangedEvent};
use crate::git;
use crate::git::types::CommandErrorKind;
use crate::watcher::{self, OnChange, WatcherState};

/// Where a progress-streaming command sends each step: a declared event name
/// from [`crate::events`] and its payload. The agent turns these into event
/// frames and the desktop re-emits them to the webview.
pub type Progress = Arc<dyn Fn(&'static str, Value) + Send + Sync>;

/// Commands that stream progress through Tauri's `AppHandle` on the desktop.
/// The agent runs the same `git::write` function with a [`Progress`] sink
/// instead, since a command fn that takes an `AppHandle` cannot run headless.
pub const PROGRESS_COMMANDS: &[&str] = &["move_branch_to_worktree", "delete_branch_with_worktree"];

/// Commands whose effect outlives the request: the agent keeps the watch for
/// as long as the session lasts, and each change it sees goes out as a
/// `repo-changed` event tagged with the id of the `watch_repo` request. The
/// desktop's versions take Tauri state, so they are not table entries.
pub const SESSION_COMMANDS: &[&str] = &["watch_repo", "unwatch_repo"];

/// The agent process's watches: one registry for every repository it serves.
static WATCHES: LazyLock<WatcherState> = LazyLock::new(WatcherState::default);

/// Whether `command` may be called with a remote (`ssh://`) locator.
pub fn is_remote_capable(command: &str) -> bool {
    [REMOTE_COMMANDS, PROGRESS_COMMANDS, SESSION_COMMANDS]
        .iter()
        .any(|set| set.contains(&command))
}

/// Read one argument the way Tauri does: under the parameter's camelCase name,
/// with a missing key read as `null` so `Option` parameters default to `None`.
fn arg<T: DeserializeOwned>(args: &Value, param: &str) -> Result<T, CommandError> {
    let key = camel(param);
    let value = args.get(&key).cloned().unwrap_or(Value::Null);
    serde_json::from_value(value)
        .map_err(|e| CommandError::internal(format!("Invalid argument `{key}`: {e}")))
}

fn camel(param: &str) -> String {
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

/// GitLane's bound accounts never apply on a remote host: fetch, pull and push
/// use the server's own credentials (`platform/git-invocation`). The desktop
/// strips these before sending; dropping them here too keeps that true for any
/// client.
pub fn without_accounts(args: &Value) -> Value {
    let mut args = args.clone();
    if let Some(map) = args.as_object_mut() {
        map.remove("auth");
        map.remove("remoteAccounts");
    }
    args
}

fn to_json<T: Serialize>(value: T) -> Result<Value, CommandError> {
    serde_json::to_value(value)
        .map_err(|e| CommandError::internal(format!("Unserializable response: {e}")))
}

/// Declares the table: each entry is a `commands::<module>::<fn>` and its
/// parameter names in order. Calls are positional, so the registration test
/// checks these names against the fn's real signature.
macro_rules! remote_commands {
    ($( $module:ident :: $name:ident ( $( $param:ident ),* ) ),* $(,)?) => {
        /// Every command served from the table, by its IPC name.
        pub const REMOTE_COMMANDS: &[&str] = &[$( stringify!($name) ),*];

        /// `(command, parameter names)` per table entry, for the registration test.
        #[cfg(test)]
        pub(crate) const REMOTE_SIGNATURES: &[(&str, &[&str])] =
            &[$( (stringify!($name), &[$( stringify!($param) ),*]) ),*];

        async fn run_table(command: &str, args: &Value) -> Option<Result<Value, CommandError>> {
            Some(match command {
                $( stringify!($name) => async {
                    to_json(commands::$module::$name($( arg(args, stringify!($param))? ),*).await?)
                }
                .await, )*
                _ => return None,
            })
        }
    };
}

remote_commands! {
    branches::checkout(path, target, detached),
    branches::checkout_remote_branch(path, remote, branch),
    branches::create_branch(path, name, start_point, expected_oid),
    branches::delete_branch(path, name, expected_oid, force),
    branches::rename_branch(path, old, new),
    branches::set_upstream(path, branch, upstream),
    branches::merge_branch(path, source, expected_source_oid, destination, expected_destination_oid),
    branches::fast_forward_branch(path, branch, expected_branch_oid, target_oid),
    branches::rebase_onto(path, source, expected_source_oid, onto_oid),
    branches::reset_to(path, request),
    branches::cherry_pick_many(path, expected_branch, expected_oid, commits),
    branches::revert_many(path, expected_branch, expected_oid, commits),
    commits::commit(path, request),
    commits::squash_commits(path, request),
    commits::squash_range(path, request),
    commits::squash_branch(path, request),
    commits::stash(path, expected_branch, expected_oid),
    commits::stash_paths(path, expected_branch, expected_oid, files),
    commits::list_stashes(path),
    commits::stash_apply(path, expected_branch, expected_oid, oid),
    commits::stash_apply_index(path, expected_branch, expected_oid, oid),
    commits::stash_branch(path, branch, oid),
    commits::stash_pop(path, expected_branch, expected_oid, oid),
    commits::stash_drop(path, oid),
    conflicts::operation_status(path),
    conflicts::conflict_file(path, file, resolved),
    conflicts::accept_conflict_side(path, file, side),
    conflicts::resolve_conflict_file(path, file, content),
    conflicts::mark_conflict_resolved(path, file),
    conflicts::reconflict_file(path, file),
    conflicts::continue_operation(path, kind, name, email, identity),
    conflicts::abort_operation(path, kind),
    conflicts::skip_operation(path, kind, name, email, identity),
    files::list_repo_files(path),
    files::repo_file_text(path, file, max_bytes),
    files::repo_file_head_text(path, file),
    identity::set_repo_identity(path, name, email, signing_key, gpg_format, gpg_sign, tag_gpg_sign),
    identity::repo_identity(path),
    identity::clear_repo_identity(path),
    recovery::list_reflog(path, limit),
    recovery::preview_reset(path, target, mode, source),
    recovery::preview_discard_all(path),
    recovery::preview_delete_branch(path, branch),
    recovery::preview_delete_remote_branch(path, remote, branch),
    recovery::preview_force_push(path, branch),
    recovery::discard_all(path, expected_state, expected_head_branch, expected_head_oid),
    recovery::inspect_index_lock(path),
    recovery::remove_index_lock(path),
    remotes::push_tag(path, name, remote, auth),
    remotes::delete_remote_tag(path, name, expected_oid, remote, auth),
    remotes::delete_remote_branch(path, remote, branch, expected_oid, auth),
    remotes::force_push(path, branch, expected_oid, route, auth),
    remotes::pull(path, branch, expected_oid, auth),
    remotes::fetch(path, remote_accounts),
    remotes::push_branch(path, branch, expected_oid, auth),
    remotes::publish_branch(path, branch, expected_oid, upstream, auth),
    remotes::list_remotes(path),
    remotes::add_remote(path, name, url),
    remotes::set_remote_url(path, name, url),
    remotes::remove_remote(path, name),
    repo::open_repo(path),
    repo::commit_graph(path, limit),
    repo::search_history(path, query),
    repo::suggest_tree_paths(path, filter, limit),
    repo::list_branches(path),
    repo::can_fast_forward(path, from, to),
    repo::range_commits(path, base, head),
    repo::ancestor_refs(path, head, candidates),
    repo::default_base_branch(path, head),
    staging::apply_hunk(path, file, staged, hunk_index, expected_header, expected_body),
    staging::apply_line(path, request),
    staging::apply_line_range(path, request),
    staging::revert_line_range(path, request),
    staging::stage_files(path, files),
    staging::unstage_files(path, files),
    staging::preview_discard_file(path, file, previous_file, staged),
    staging::discard_file(path, file, previous_file, staged, expected_state),
    staging::append_ignore_pattern(path, pattern, local),
    staging::stop_tracking(path, file),
    staging::worktree_differs_from_commit(path, commit_oid, file),
    staging::commit_path_is_restorable(path, commit_oid, file),
    staging::restore_path_from_commit(path, commit_oid, file),
    staging::stage_all(path),
    staging::unstage_all(path),
    status::working_changes(path),
    status::file_diff(path, file, staged, full),
    status::working_file_differences(path, file, whole_file),
    status::commit_files(path, oid),
    status::read_binary_blob(path, oid, file, max_bytes),
    status::commit_file_diff(path, oid, file, full),
    status::diff_range(path, base, head),
    status::diff_range_file(path, base, head, file, full),
    status::file_history(path, file, offset, limit),
    status::file_blame(path, file, revision, limit),
    status::compare_refs(path, base, head),
    status::compare_file_diff(path, base, head, file, full),
    status::selection_diff(path, oids),
    status::selection_diff_file(path, oids, file, full),
    tags::create_tag(path, name, sha),
    tags::create_annotated_tag(path, name, message, sha),
    tags::create_patch(path, sha),
    tags::create_patch_range(path, base, head),
    tags::create_working_tree_patch(path, file),
    tags::delete_tag(path, name, expected_oid),
    worktrees::list_worktrees(path),
    worktrees::add_worktree(path, worktree_path, reference, new_branch),
    worktrees::create_branch_in_worktree(path, worktree_path, name, expected_oid),
    worktrees::preview_remove_worktree(path, worktree_path),
    worktrees::remove_worktree(path, worktree_path, expected_state),
    worktrees::worktree_dirty_state(worktree_path),
    worktrees::worktree_is_dirty(worktree_path),
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

#[cfg(test)]
mod tests;
