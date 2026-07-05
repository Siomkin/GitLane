//! GitLane Tauri commands — the IPC boundary the React frontend calls into.
//!
//! Read commands return rich serializable structs (see `git::types`); write
//! commands return the raw `git` CLI output so the UI can surface it.

mod auth_providers;
mod git;
mod shell;
mod signing_keys;
mod terminal;
mod terminal_agents;
mod watcher;

use terminal::TerminalState;
use terminal_agents::TerminalAgent;
use watcher::WatcherState;

use git::types::{
    BinaryBlob, BranchInfo, CompareResult, ConflictFileContent, DestructivePreview, FileBlame,
    FileChange,
    FileDiff, FileHistoryPage, ForgeAccount, ForgeAuthStatus, GithubAccount, GithubAccountRef,
    DeleteWorktreeProgressEvent, GithubSignInResult, HandoffProgressEvent, OperationStatus,
    PrCheck, PrCommit, PullRequestDetail, PullRequestSummary, RecentStatus, ReflogEntry,
    RemoteAccountRef, RemoteInfo, RepoForge, RepoGraph, RepoIdentity, RepoOpenError, RepoSummary,
    ReviewThread, SigningKey, StashEntry, WorkingChanges,
    WorktreeInfo,
};

/// Initial graph window. The frontend explicitly increases this in 2,000-commit
/// pages while virtualized rows/canvas keep rendering memory bounded.
const DEFAULT_GRAPH_LIMIT: usize = 2000;

/// Holds the in-flight `git clone` child so [`cancel_clone`] can terminate it
/// from another command while the clone streams progress. The inner [`Arc`] is
/// cloned out before the clone runs on the blocking pool.
#[derive(Default)]
struct CloneState(git::write::CloneSlot);

/// Holds the in-flight `gh auth login --web` child so [`cancel_github_sign_in`]
/// can terminate it while the device flow streams progress (GL-106). Mirrors
/// [`CloneState`].
#[derive(Default)]
struct SignInState(git::github::SignInSlot);

/// Run blocking work (a `git`/`gh` subprocess) off the webview's main thread.
/// Synchronous Tauri commands execute on the main thread, so a blocking
/// subprocess there freezes the whole UI (no repaint) until it returns; wrapping
/// the work in `spawn_blocking` keeps the UI responsive. In-process libgit2
/// reads stay synchronous — they're fast and don't shell out.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("git task failed: {e:?}"))?
}

#[tauri::command]
fn open_repo(path: String) -> Result<RepoSummary, RepoOpenError> {
    // The one command with a structured error: the frontend needs to tell a
    // moved/deleted repository apart from a real failure to offer the dedicated
    // missing-repo state with Remove / Locate / Retry (GL-108).
    git::read::summary_classified(&path)
}

#[tauri::command]
async fn commit_graph(path: String, limit: Option<usize>) -> Result<RepoGraph, String> {
    let limit = limit.unwrap_or(DEFAULT_GRAPH_LIMIT);
    // Large histories can spend hundreds of milliseconds in ref collection,
    // revwalk, lane layout, and serialization. Open the non-Send Repository
    // inside the worker closure so none of that blocks the webview thread.
    blocking(move || git::read::commit_graph(&path, limit).map_err(|e| e.to_string())).await
}

#[tauri::command]
fn list_branches(path: String) -> Result<Vec<BranchInfo>, String> {
    git::read::branches(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_worktrees(path: String) -> Result<Vec<WorktreeInfo>, String> {
    blocking(move || git::write::worktrees(&path)).await
}

#[tauri::command]
async fn add_worktree(
    path: String,
    worktree_path: String,
    reference: Option<String>,
    new_branch: Option<String>,
) -> Result<String, String> {
    blocking(move || {
        git::write::add_worktree(
            &path,
            &worktree_path,
            reference.as_deref(),
            new_branch.as_deref(),
        )
    })
    .await
}

#[tauri::command]
async fn move_branch_to_worktree(
    app: tauri::AppHandle,
    path: String,
    branch: String,
    from_worktree_path: String,
    to_worktree_path: String,
    carry: bool,
) -> Result<String, String> {
    use tauri::Emitter;
    blocking(move || {
        git::write::move_branch_to_worktree(
            &path,
            &branch,
            &from_worktree_path,
            &to_worktree_path,
            carry,
            // Forward each phase to the webview so the hand-off dialog can tick
            // its checklist live; a lost event only degrades the progress UI.
            &|step| {
                let _ = app.emit(
                    "handoff-progress",
                    HandoffProgressEvent { step: step.to_string() },
                );
            },
        )
    })
    .await
}

#[tauri::command]
async fn delete_branch_with_worktree(
    app: tauri::AppHandle,
    path: String,
    branch: String,
    from_worktree_path: String,
) -> Result<String, String> {
    use tauri::Emitter;
    blocking(move || {
        git::write::delete_branch_with_worktree(
            &path,
            &branch,
            &from_worktree_path,
            // Forward each phase to the webview so the delete dialog can tick its
            // checklist live; a lost event only degrades the progress UI.
            &|step| {
                let _ = app.emit(
                    "delete-worktree-progress",
                    DeleteWorktreeProgressEvent { step: step.to_string() },
                );
            },
        )
    })
    .await
}

#[tauri::command]
async fn checkout(path: String, target: String) -> Result<String, String> {
    blocking(move || git::write::checkout(&path, &target)).await
}

#[tauri::command]
async fn create_branch(
    path: String,
    name: String,
    start_point: Option<String>,
) -> Result<String, String> {
    blocking(move || git::write::create_branch(&path, &name, start_point.as_deref())).await
}

#[tauri::command]
async fn delete_branch(path: String, name: String, force: bool) -> Result<String, String> {
    blocking(move || git::write::delete_branch(&path, &name, force)).await
}

#[tauri::command]
async fn list_reflog(path: String, limit: Option<usize>) -> Result<Vec<ReflogEntry>, String> {
    // Clamp the caller-supplied limit: the UI requests 120, but the command
    // surface must not let a stray large value trigger an unbounded reflog walk.
    let limit = limit.unwrap_or(80).clamp(1, 500);
    blocking(move || git::write::reflog_entries(&path, limit)).await
}

#[tauri::command]
async fn preview_reset(
    path: String,
    target: String,
    mode: String,
    source: Option<String>,
) -> Result<DestructivePreview, String> {
    // `source` is the ref being reset; defaults to HEAD for current-branch resets.
    let source = source.unwrap_or_else(|| "HEAD".to_string());
    blocking(move || git::write::preview_reset(&path, &target, &mode, &source)).await
}

#[tauri::command]
async fn preview_discard_all(path: String) -> Result<DestructivePreview, String> {
    blocking(move || git::write::preview_discard_all(&path)).await
}

#[tauri::command]
async fn preview_delete_branch(path: String, branch: String) -> Result<DestructivePreview, String> {
    blocking(move || git::write::preview_delete_branch(&path, &branch)).await
}

#[tauri::command]
async fn preview_delete_remote_branch(
    path: String,
    remote: String,
    branch: String,
) -> Result<DestructivePreview, String> {
    blocking(move || git::write::preview_delete_remote_branch(&path, &remote, &branch)).await
}

#[tauri::command]
async fn preview_force_push(path: String, branch: String) -> Result<DestructivePreview, String> {
    blocking(move || git::write::preview_force_push(&path, &branch)).await
}

#[tauri::command]
async fn rename_branch(path: String, old: String, new: String) -> Result<String, String> {
    blocking(move || git::write::rename_branch(&path, &old, &new)).await
}

#[tauri::command]
async fn set_upstream(path: String, branch: String, upstream: String) -> Result<String, String> {
    blocking(move || git::write::set_upstream(&path, &branch, &upstream)).await
}

#[tauri::command]
async fn merge_branch(path: String, branch: String) -> Result<String, String> {
    blocking(move || git::write::merge(&path, &branch)).await
}

#[tauri::command]
fn can_fast_forward(path: String, from: String, to: String) -> Result<bool, String> {
    git::read::can_fast_forward(&path, &from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fast_forward(path: String, target: String) -> Result<String, String> {
    blocking(move || git::write::fast_forward(&path, &target)).await
}

#[tauri::command]
async fn fast_forward_branch(
    path: String,
    branch: String,
    target: String,
) -> Result<String, String> {
    blocking(move || git::write::fast_forward_branch(&path, &branch, &target)).await
}

#[tauri::command]
async fn rebase_onto(path: String, onto: String) -> Result<String, String> {
    blocking(move || git::write::rebase(&path, &onto)).await
}

#[tauri::command]
async fn reset_to(path: String, target: String, mode: String) -> Result<String, String> {
    blocking(move || git::write::reset(&path, &target, &mode)).await
}

#[tauri::command]
async fn cherry_pick(path: String, commit: String) -> Result<String, String> {
    blocking(move || git::write::cherry_pick(&path, &commit)).await
}

#[tauri::command]
async fn cherry_pick_many(path: String, commits: Vec<String>) -> Result<String, String> {
    blocking(move || git::write::cherry_pick_many(&path, &commits)).await
}

#[tauri::command]
async fn revert_commit(path: String, commit: String) -> Result<String, String> {
    blocking(move || git::write::revert(&path, &commit)).await
}

#[tauri::command]
async fn revert_many(path: String, commits: Vec<String>) -> Result<String, String> {
    blocking(move || git::write::revert_many(&path, &commits)).await
}

// ---- Conflict resolution ----

#[tauri::command]
async fn operation_status(path: String) -> Result<OperationStatus, String> {
    blocking(move || git::conflicts::operation_status(&path).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn conflict_file(path: String, file: String) -> Result<ConflictFileContent, String> {
    blocking(move || git::conflicts::conflict_file(&path, &file).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn accept_conflict_side(path: String, file: String, side: String) -> Result<String, String> {
    blocking(move || git::write::accept_conflict_side(&path, &file, &side)).await
}

#[tauri::command]
async fn resolve_conflict_file(
    path: String,
    file: String,
    content: String,
) -> Result<String, String> {
    blocking(move || git::write::resolve_conflict_file(&path, &file, &content)).await
}

#[tauri::command]
async fn mark_conflict_resolved(path: String, file: String) -> Result<String, String> {
    blocking(move || git::write::mark_conflict_resolved(&path, &file)).await
}

#[tauri::command]
async fn reconflict_file(path: String, file: String) -> Result<String, String> {
    blocking(move || git::write::reconflict_file(&path, &file)).await
}

#[tauri::command]
async fn continue_operation(
    path: String,
    kind: String,
    name: Option<String>,
    email: Option<String>,
) -> Result<String, String> {
    blocking(move || {
        git::write::continue_operation(&path, &kind, name.as_deref(), email.as_deref())
    })
    .await
}

#[tauri::command]
async fn abort_operation(path: String, kind: String) -> Result<String, String> {
    blocking(move || git::write::abort_operation(&path, &kind)).await
}

#[tauri::command]
async fn skip_operation(path: String, kind: String) -> Result<String, String> {
    blocking(move || git::write::skip_operation(&path, &kind)).await
}

#[tauri::command]
async fn create_tag(path: String, name: String, sha: Option<String>) -> Result<String, String> {
    blocking(move || git::write::create_tag(&path, &name, sha.as_deref())).await
}

#[tauri::command]
async fn create_annotated_tag(
    path: String,
    name: String,
    message: String,
    sha: Option<String>,
) -> Result<String, String> {
    blocking(move || git::write::create_annotated_tag(&path, &name, &message, sha.as_deref())).await
}

#[tauri::command]
async fn create_patch(path: String, sha: String) -> Result<String, String> {
    blocking(move || git::write::create_patch(&path, &sha)).await
}

#[tauri::command]
async fn delete_tag(path: String, name: String) -> Result<String, String> {
    blocking(move || git::write::delete_tag(&path, &name)).await
}

/// Push a tag to `remote` (the default push remote when not given), optionally
/// pinned to that remote's bound GitHub account. The token is resolved
/// server-side via the provider, never passed in from the frontend (same as
/// [`push`]).
#[tauri::command]
async fn push_tag(
    path: String,
    name: String,
    remote: Option<String>,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    blocking(move || {
        let remote = remote
            .or_else(|| git::forge::default_remote(&path))
            .unwrap_or_else(|| "origin".to_string());
        let auth = git::github::git_auth_for_remote(&path, &remote, account.as_ref())?;
        let auth_ref = auth
            .as_ref()
            .map(|(host, token)| (host.as_str(), token.as_str()));
        git::write::push_tag(&path, &name, &remote, auth_ref)
    })
    .await
}

/// Delete a tag on `remote` (the default push remote when not given),
/// optionally pinned to that remote's bound GitHub account. Token resolved
/// server-side, like [`push`]. Local deletion is the separate [`delete_tag`] —
/// without the remote delete, fetch's `refs/tags/*` import resurrects a locally
/// deleted tag that still exists upstream.
#[tauri::command]
async fn delete_remote_tag(
    path: String,
    name: String,
    remote: Option<String>,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    blocking(move || {
        let remote = remote
            .or_else(|| git::forge::default_remote(&path))
            .unwrap_or_else(|| "origin".to_string());
        let auth = git::github::git_auth_for_remote(&path, &remote, account.as_ref())?;
        let auth_ref = auth
            .as_ref()
            .map(|(host, token)| (host.as_str(), token.as_str()));
        git::write::delete_remote_tag(&path, &remote, &name, auth_ref)
    })
    .await
}

#[tauri::command]
async fn remove_worktree(
    path: String,
    worktree_path: String,
    force: bool,
) -> Result<String, String> {
    blocking(move || git::write::remove_worktree(&path, &worktree_path, force)).await
}

/// Delete `branch` on `remote`, optionally pinned to that remote's bound
/// GitHub account. Token resolved server-side, like [`push`].
#[tauri::command]
async fn delete_remote_branch(
    path: String,
    remote: String,
    branch: String,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    blocking(move || {
        let auth = git::github::git_auth_for_remote(&path, &remote, account.as_ref())?;
        let auth_ref = auth
            .as_ref()
            .map(|(host, token)| (host.as_str(), token.as_str()));
        git::write::delete_remote_branch(&path, &remote, &branch, auth_ref)
    })
    .await
}

/// Force-push a specific `branch` with `--force-with-lease`, optionally pinned
/// to the target remote's bound GitHub account. The account is validated
/// against the branch's push remote, so a stale binding fails loudly instead of
/// pushing with the wrong token. Token resolved server-side, like [`push`].
#[tauri::command]
async fn force_push(
    path: String,
    branch: String,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    blocking(move || {
        let remote = git::write::branch_push_remote(&path, &branch);
        let auth = git::github::git_auth_for_remote(&path, &remote, account.as_ref())?;
        let auth_ref = auth
            .as_ref()
            .map(|(host, token)| (host.as_str(), token.as_str()));
        git::write::force_push(&path, &branch, auth_ref)
    })
    .await
}

#[tauri::command]
async fn discard_all(path: String) -> Result<String, String> {
    blocking(move || git::write::discard_all(&path)).await
}

// ---- working tree / staging ----

#[tauri::command]
fn working_changes(path: String) -> Result<WorkingChanges, String> {
    git::status::working_changes(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn file_diff(
    path: String,
    file: String,
    staged: bool,
    full: Option<bool>,
) -> Result<FileDiff, String> {
    git::status::file_diff(&path, &file, staged, full.unwrap_or(false)).map_err(|e| e.to_string())
}

#[tauri::command]
fn commit_files(path: String, oid: String) -> Result<Vec<FileChange>, String> {
    git::status::commit_files(&path, &oid).map_err(|e| e.to_string())
}

/// Read a binary blob's bytes (base64) for an inline preview. `oid` selects a
/// committed/staged blob; omit it (with `file` set) to read the working-tree
/// file by path — the side libgit2 leaves without a blob oid in an unstaged diff.
///
/// Reads up to a few MiB off disk/ODB and base64-encodes it, so it runs on the
/// blocking pool (like `commit_graph`) to keep the webview thread responsive when
/// several image panes load at once.
#[tauri::command]
async fn read_binary_blob(
    path: String,
    oid: Option<String>,
    file: Option<String>,
    max_bytes: Option<u64>,
) -> Result<BinaryBlob, String> {
    blocking(move || {
        git::status::read_binary_blob(&path, oid.as_deref(), file.as_deref(), max_bytes)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
fn commit_file_diff(
    path: String,
    oid: String,
    file: String,
    full: Option<bool>,
) -> Result<FileDiff, String> {
    git::status::commit_file_diff(&path, &oid, &file, full.unwrap_or(false))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn diff_range(path: String, base: String, head: String) -> Result<Vec<FileChange>, String> {
    git::status::diff_range(&path, &base, &head).map_err(|e| e.to_string())
}

#[tauri::command]
fn diff_range_file(
    path: String,
    base: String,
    head: String,
    file: String,
    full: Option<bool>,
) -> Result<FileDiff, String> {
    git::status::diff_range_file(&path, &base, &head, &file, full.unwrap_or(false))
        .map_err(|e| e.to_string())
}

// These reads can be expensive on large repos — a multi-thousand-commit history
// walk (each step diffing one file), blame over a long file, or a full-tree
// comparison. Like `commit_graph`, run them on the blocking pool so they never
// stall the webview thread (the non-Send Repository is opened inside the closure).
#[tauri::command]
async fn file_history(
    path: String,
    file: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<FileHistoryPage, String> {
    blocking(move || git::status::file_history(&path, &file, offset, limit).map_err(|e| e.to_string()))
        .await
}

#[tauri::command]
async fn file_blame(
    path: String,
    file: String,
    revision: Option<String>,
    limit: Option<usize>,
) -> Result<FileBlame, String> {
    blocking(move || git::status::file_blame(&path, &file, revision, limit).map_err(|e| e.to_string()))
        .await
}

#[tauri::command]
async fn compare_refs(
    path: String,
    base: String,
    head: Option<String>,
) -> Result<CompareResult, String> {
    blocking(move || git::status::compare_refs(&path, &base, head.as_deref()).map_err(|e| e.to_string()))
        .await
}

#[tauri::command]
async fn compare_file_diff(
    path: String,
    base: String,
    head: Option<String>,
    file: String,
    full: Option<bool>,
) -> Result<FileDiff, String> {
    blocking(move || {
        git::status::compare_file_diff(&path, &base, head.as_deref(), &file, full.unwrap_or(false))
            .map_err(|e| e.to_string())
    })
    .await
}

/// Merged ("union") diff across a multi-commit selection (GL-69): the net change
/// per file across an arbitrary `oids` set. Walks one tree diff per selected
/// commit, so it runs on the blocking pool like the other range reads.
#[tauri::command]
async fn selection_diff(path: String, oids: Vec<String>) -> Result<Vec<FileChange>, String> {
    blocking(move || git::status::selection_diff(&path, &oids).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn selection_diff_file(
    path: String,
    oids: Vec<String>,
    file: String,
    full: Option<bool>,
) -> Result<FileDiff, String> {
    blocking(move || {
        git::status::selection_diff_file(&path, &oids, &file, full.unwrap_or(false))
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn stage_file(path: String, file: String) -> Result<String, String> {
    blocking(move || git::write::stage_file(&path, &file)).await
}

#[tauri::command]
async fn unstage_file(path: String, file: String) -> Result<String, String> {
    blocking(move || git::write::unstage_file(&path, &file)).await
}

#[tauri::command]
async fn apply_hunk(
    path: String,
    file: String,
    staged: bool,
    hunk_index: usize,
    expected_header: String,
    expected_body: String,
) -> Result<String, String> {
    blocking(move || {
        git::write::apply_hunk(&path, &file, staged, hunk_index, &expected_header, &expected_body)
    })
    .await
}

#[tauri::command]
async fn apply_line(
    path: String,
    file: String,
    staged: bool,
    hunk_index: usize,
    line_index: usize,
    expected_kind: String,
    expected_content: String,
    expected_old_no: Option<u32>,
    expected_new_no: Option<u32>,
) -> Result<String, String> {
    blocking(move || {
        git::write::apply_line(
            &path,
            &file,
            staged,
            hunk_index,
            line_index,
            &expected_kind,
            &expected_content,
            expected_old_no,
            expected_new_no,
        )
    })
    .await
}

#[tauri::command]
async fn stage_files(path: String, files: Vec<String>) -> Result<String, String> {
    blocking(move || git::write::stage_files(&path, &files)).await
}

#[tauri::command]
async fn unstage_files(path: String, files: Vec<String>) -> Result<String, String> {
    blocking(move || git::write::unstage_files(&path, &files)).await
}

#[tauri::command]
async fn discard_file(path: String, file: String, staged: bool) -> Result<String, String> {
    blocking(move || git::write::discard_file(&path, &file, staged)).await
}

#[tauri::command]
async fn stage_all(path: String) -> Result<String, String> {
    blocking(move || git::write::stage_all(&path)).await
}

#[tauri::command]
async fn unstage_all(path: String) -> Result<String, String> {
    blocking(move || git::write::unstage_all(&path)).await
}

#[tauri::command]
async fn commit(
    path: String,
    summary: String,
    description: String,
    amend: bool,
    name: Option<String>,
    email: Option<String>,
) -> Result<String, String> {
    blocking(move || {
        git::write::commit(
            &path,
            &summary,
            &description,
            amend,
            name.as_deref(),
            email.as_deref(),
        )
    })
    .await
}

#[tauri::command]
async fn stash(path: String) -> Result<String, String> {
    blocking(move || git::write::stash(&path)).await
}

#[tauri::command]
async fn list_stashes(path: String) -> Result<Vec<StashEntry>, String> {
    blocking(move || git::write::stash_list(&path)).await
}

// Stashes are addressed by commit oid, not `stash@{n}` — indices are
// reflog-relative and global across worktrees, so one captured at list time can
// point at a different stash by the time the user acts (GL-117).
#[tauri::command]
async fn stash_apply(path: String, oid: String) -> Result<String, String> {
    blocking(move || git::write::stash_apply(&path, &oid)).await
}

#[tauri::command]
async fn stash_apply_index(path: String, oid: String) -> Result<String, String> {
    blocking(move || git::write::stash_apply_index(&path, &oid)).await
}

#[tauri::command]
async fn stash_branch(path: String, branch: String, oid: String) -> Result<String, String> {
    blocking(move || git::write::stash_branch(&path, &branch, &oid)).await
}

#[tauri::command]
async fn stash_pop(path: String, oid: String) -> Result<String, String> {
    blocking(move || git::write::stash_pop(&path, &oid)).await
}

#[tauri::command]
async fn stash_drop(path: String, oid: String) -> Result<String, String> {
    blocking(move || git::write::stash_drop(&path, &oid)).await
}

#[tauri::command]
async fn pull(path: String) -> Result<String, String> {
    blocking(move || git::write::pull(&path)).await
}

/// Fetch + prune every non-skipped remote, each authenticated as **its own**
/// bound account (GL-129). `remote_accounts` carries one `{remote, account}`
/// pair per bound remote; unlisted remotes fetch through the system credential
/// helpers / SSH. Tokens are resolved server-side (deduplicated per account),
/// never passed in from the frontend.
#[tauri::command]
async fn fetch(
    path: String,
    remote_accounts: Option<Vec<RemoteAccountRef>>,
) -> Result<String, String> {
    blocking(move || {
        let entries: Vec<(String, GithubAccountRef)> = remote_accounts
            .unwrap_or_default()
            .into_iter()
            .map(|pair| (pair.remote, pair.account))
            .collect();
        let auth_by_remote: std::collections::HashMap<String, (String, String)> =
            git::github::git_auth_for_remotes(&path, &entries)?
                .into_iter()
                .collect();
        git::write::fetch(&path, &auth_by_remote)
    })
    .await
}

/// Push the checked-out branch, optionally pinned to its target remote's bound
/// GitHub account. The account is validated against the branch's push remote.
/// The token is resolved server-side via the provider, never passed in from
/// the frontend.
#[tauri::command]
async fn push(path: String, account: Option<GithubAccountRef>) -> Result<String, String> {
    blocking(move || {
        let remote = git::write::head_push_remote(&path);
        let auth = git::github::git_auth_for_remote(&path, &remote, account.as_ref())?;
        let auth_ref = auth
            .as_ref()
            .map(|(host, token)| (host.as_str(), token.as_str()));
        git::write::push(&path, auth_ref)
    })
    .await
}

/// Push a specific `branch` (used when it isn't the checked-out branch) to its
/// configured remote, falling back to origin. Token resolved server-side from
/// the target remote's bound `account`, like [`push`].
#[tauri::command]
async fn push_branch(
    path: String,
    branch: String,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    blocking(move || {
        let remote = git::write::branch_push_remote(&path, &branch);
        let auth = git::github::git_auth_for_remote(&path, &remote, account.as_ref())?;
        let auth_ref = auth
            .as_ref()
            .map(|(host, token)| (host.as_str(), token.as_str()));
        git::write::push_branch(&path, &branch, auth_ref)
    })
    .await
}

/// Publish a local branch to `upstream` (`remote/branch`) and set upstream in
/// one push. Token resolved server-side from the target remote's bound
/// `account`, like [`push`].
#[tauri::command]
async fn publish_branch(
    path: String,
    branch: String,
    upstream: String,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    blocking(move || {
        let remote = git::write::publish_remote(&path, &upstream)?;
        let auth = git::github::git_auth_for_remote(&path, &remote, account.as_ref())?;
        let auth_ref = auth
            .as_ref()
            .map(|(host, token)| (host.as_str(), token.as_str()));
        git::write::publish_branch(&path, &branch, &upstream, auth_ref)
    })
    .await
}

// ---- GitHub (gh CLI) ----

#[tauri::command]
async fn github_accounts() -> Result<Vec<GithubAccount>, String> {
    blocking(git::github::accounts).await
}

/// Sign in a GitHub account in-app via `gh auth login --web` (GL-106). Streams
/// `github-signin-progress` events; the child is parked in [`SignInState`] so
/// [`cancel_github_sign_in`] can stop it. Returns the newly added `{host, login}`.
#[tauri::command]
async fn github_sign_in(
    app: tauri::AppHandle,
    state: tauri::State<'_, SignInState>,
    host: String,
) -> Result<GithubSignInResult, String> {
    let slot = state.0.clone();
    blocking(move || git::github::sign_in_web(&app, slot, &host)).await
}

/// Terminate an in-flight [`github_sign_in`]. Instant (lock + kill), so it stays a
/// plain sync command and never queues behind the blocking pool.
#[tauri::command]
fn cancel_github_sign_in(state: tauri::State<'_, SignInState>) -> Result<(), String> {
    git::github::cancel_sign_in(&state.0)
}

#[tauri::command]
async fn forge_auth_statuses() -> Result<Vec<ForgeAuthStatus>, String> {
    blocking(|| Ok(auth_providers::statuses())).await
}

#[tauri::command]
async fn forge_account(provider: String) -> Result<Option<ForgeAccount>, String> {
    blocking(move || Ok(auth_providers::account(&provider))).await
}

/// Detect the open repo's remote forge for the toolbar provider indicator.
/// A cheap synchronous libgit2 read of the configured remotes (no network, no
/// auth probing) — kept sync like the other `read.rs`-style reads; only
/// shell-outs and the heavy `commit_graph` walk use `blocking()`.
#[tauri::command]
fn repo_forge(path: String) -> Result<RepoForge, String> {
    Ok(git::forge::summary(&path))
}

/// List the repo's configured remotes (Repository settings → Remotes). Cheap
/// synchronous libgit2 read, like the other `read.rs` reads.
#[tauri::command]
fn list_remotes(path: String) -> Result<Vec<RemoteInfo>, String> {
    git::read::list_remotes(&path)
}

/// Add a new remote `name` → `url` (`git remote add`).
#[tauri::command]
async fn add_remote(path: String, name: String, url: String) -> Result<String, String> {
    blocking(move || git::write::add_remote(&path, &name, &url)).await
}

/// Repoint an existing remote at a new `url` (`git remote set-url`).
#[tauri::command]
async fn set_remote_url(path: String, name: String, url: String) -> Result<String, String> {
    blocking(move || git::write::set_remote_url(&path, &name, &url)).await
}

/// Remove a remote (`git remote remove`).
#[tauri::command]
async fn remove_remote(path: String, name: String) -> Result<String, String> {
    blocking(move || git::write::remove_remote(&path, &name)).await
}

// These shell out to the `gh` CLI (token resolution + the API call), which
// blocks for ~1s+. They are `async` and run the blocking work on the blocking
// thread pool so the webview's main thread stays free — a synchronous command
// runs on the main thread and freezes the whole UI (no repaint, no spinner)
// for the duration of the subprocess.
#[tauri::command]
async fn list_pull_requests(
    path: String,
    account: Option<GithubAccountRef>,
) -> Result<Vec<PullRequestSummary>, String> {
    blocking(move || git::github::list_prs(&path, account.as_ref())).await
}

#[tauri::command]
async fn pull_request_detail(
    path: String,
    number: u64,
    account: Option<GithubAccountRef>,
) -> Result<PullRequestDetail, String> {
    blocking(move || git::github::pr_detail(&path, number, account.as_ref())).await
}

#[tauri::command]
async fn pull_request_checks(
    path: String,
    number: u64,
    account: Option<GithubAccountRef>,
) -> Result<Vec<PrCheck>, String> {
    blocking(move || git::github::pr_checks(&path, number, account.as_ref())).await
}

/// The full, verified PR commit list (GraphQL, paginated), loaded lazily when the
/// Commits tab is opened so `pull_request_detail` stays a single fast call. This
/// supersedes the capped `gh pr view` commit projection carried on the detail.
#[tauri::command]
async fn pull_request_commits(
    path: String,
    number: u64,
    account: Option<GithubAccountRef>,
) -> Result<Vec<PrCommit>, String> {
    blocking(move || git::github::pr_commits(&path, number, account.as_ref())).await
}

/// Inline review threads for a PR (file/line-anchored comments + resolve state).
#[tauri::command]
async fn pull_request_review_threads(
    path: String,
    number: u64,
    account: Option<GithubAccountRef>,
) -> Result<Vec<ReviewThread>, String> {
    blocking(move || git::github::review_threads(&path, number, account.as_ref())).await
}

/// Resolve or unresolve a review thread by its GraphQL node id.
#[tauri::command]
async fn resolve_review_thread(
    path: String,
    thread_id: String,
    resolved: bool,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    blocking(move || {
        git::github::set_thread_resolved(&path, &thread_id, resolved, account.as_ref())
    })
    .await
}

/// Add a reply to an existing review thread by its GraphQL node id.
#[tauri::command]
async fn reply_review_thread(
    path: String,
    thread_id: String,
    body: String,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    blocking(move || git::github::reply_thread(&path, &thread_id, &body, account.as_ref())).await
}

/// Full unified diff of a PR, parsed server-side into `FileDiff`s for the viewer.
#[tauri::command]
async fn pull_request_diff(
    path: String,
    number: u64,
    account: Option<GithubAccountRef>,
) -> Result<Vec<FileDiff>, String> {
    blocking(move || git::github::pr_diff(&path, number, account.as_ref())).await
}

/// Merge a PR. `method` is "merge" | "squash" | "rebase".
#[tauri::command]
async fn merge_pull_request(
    path: String,
    number: u64,
    method: String,
    delete_branch: bool,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    blocking(move || git::github::merge_pr(&path, number, &method, delete_branch, account.as_ref()))
        .await
}

/// Post a discussion comment on a PR.
#[tauri::command]
async fn comment_pull_request(
    path: String,
    number: u64,
    body: String,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    blocking(move || git::github::comment_pr(&path, number, &body, account.as_ref())).await
}

/// Submit a review. `action` is "approve" | "request-changes" | "comment".
#[tauri::command]
async fn review_pull_request(
    path: String,
    number: u64,
    action: String,
    body: String,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    blocking(move || git::github::review_pr(&path, number, &action, &body, account.as_ref())).await
}

/// Change a PR's lifecycle state. `action` is "close" | "reopen" | "ready".
#[tauri::command]
async fn set_pull_request_state(
    path: String,
    number: u64,
    action: String,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    blocking(move || git::github::set_pr_state(&path, number, &action, account.as_ref())).await
}

/// Open a new PR from `head` into `base`. Returns the new PR URL.
#[tauri::command]
async fn create_pull_request(
    path: String,
    base: String,
    head: String,
    title: String,
    body: String,
    draft: bool,
    account: Option<GithubAccountRef>,
) -> Result<String, String> {
    blocking(move || {
        git::github::create_pr(&path, &base, &head, &title, &body, draft, account.as_ref())
    })
    .await
}

#[tauri::command]
async fn set_repo_identity(
    path: String,
    name: String,
    email: String,
    signing_key: Option<String>,
    gpg_format: Option<String>,
    gpg_sign: Option<bool>,
    tag_gpg_sign: Option<bool>,
) -> Result<String, String> {
    blocking(move || {
        git::write::set_repo_identity(
            &path,
            &name,
            &email,
            signing_key.as_deref(),
            gpg_format.as_deref(),
            gpg_sign,
            tag_gpg_sign,
        )
    })
    .await
}

#[tauri::command]
async fn list_signing_keys() -> Result<Vec<SigningKey>, String> {
    blocking(|| Ok(signing_keys::list())).await
}

#[tauri::command]
fn repo_identity(path: String) -> Result<Option<RepoIdentity>, String> {
    git::read::repo_identity(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn default_git_identity() -> Option<RepoIdentity> {
    git::read::default_identity()
}

#[tauri::command]
async fn clear_repo_identity(path: String) -> Result<String, String> {
    blocking(move || git::write::clear_repo_identity(&path)).await
}

// ---- repository onboarding (clone / init / recents) ----

/// Clone `url` into `dest`, streaming `clone-progress` events as it runs. The
/// child is parked in [`CloneState`] so [`cancel_clone`] can stop it. Returns the
/// cloned path on success; the frontend then opens it.
#[tauri::command]
async fn clone_repo(
    app: tauri::AppHandle,
    state: tauri::State<'_, CloneState>,
    url: String,
    dest: String,
) -> Result<String, String> {
    let slot = state.0.clone();
    blocking(move || git::write::clone(&app, slot, &url, &dest)).await
}

/// Terminate an in-flight [`clone_repo`]. Instant (lock + kill), so it stays a
/// plain sync command and never queues behind the blocking pool the clone holds.
#[tauri::command]
fn cancel_clone(state: tauri::State<'_, CloneState>) -> Result<(), String> {
    git::write::cancel_clone(&state.0)
}

/// Initialize a new repository at `parent`/`name` on `branch`, optionally seeding
/// a README and a `.gitignore` template. Returns the new repo's path.
#[tauri::command]
async fn init_repo(
    parent: String,
    name: String,
    branch: String,
    readme: bool,
    gitignore: String,
) -> Result<String, String> {
    blocking(move || git::write::init(&parent, &name, &branch, readme, &gitignore)).await
}

/// Presence + current branch for each recent repo path, so the onboarding list
/// can flag missing paths and show branches. Touches the filesystem per path, so
/// it runs off the main thread.
#[tauri::command]
async fn recents_status(paths: Vec<String>) -> Result<Vec<RecentStatus>, String> {
    blocking(move || Ok(git::read::recents_status(&paths))).await
}

/// Reveal `path` in the OS file manager (Finder/Explorer). Spawns and returns
/// immediately, so a plain sync command is fine.
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    shell::reveal(&path)
}

// ---- terminal ----

/// All configured terminal agents (enabled + disabled), each with its command's
/// availability probed via PATH. Probing can touch the filesystem for each
/// agent, so it runs off the main thread. The config file is the source of
/// truth; the frontend edits it through [`terminal_agents_set`].
#[tauri::command]
async fn terminal_agents_get(app: tauri::AppHandle) -> Result<Vec<TerminalAgent>, String> {
    blocking(move || Ok(terminal_agents::load(&app))).await
}

/// Persist the full agent list (replaces the config). `available` is ignored —
/// it's recomputed on the next [`terminal_agents_get`]. File I/O only, no
/// subprocess, so a plain sync command is fine (see read/write split rules).
#[tauri::command]
fn terminal_agents_set(app: tauri::AppHandle, agents: Vec<TerminalAgent>) -> Result<(), String> {
    terminal_agents::save(&app, &agents)
}

/// Reset the agent config to the shipped defaults and return them. Used by the
/// Settings "Reset to defaults" action.
#[tauri::command]
async fn terminal_agents_reset(app: tauri::AppHandle) -> Result<Vec<TerminalAgent>, String> {
    // Returns probed agents, so it touches PATH like terminal_agents_get — keep
    // the same off-the-main-thread discipline.
    blocking(move || terminal_agents::reset_to_defaults(&app)).await
}

/// Probe whether a single agent command's executable resolves on PATH. Backs
/// the Settings "Check" button, which validates a command (possibly unsaved)
/// live. It can touch the filesystem, so it runs off the main thread.
#[tauri::command]
async fn terminal_agent_probe(command: String) -> Result<bool, String> {
    blocking(move || Ok(terminal_agents::probe(&command))).await
}

/// Spawn (or replace) the in-app terminal's PTY running the user's login shell
/// in `path`. Output streams back as `pty-data` events; exit fires `pty-exit`.
#[tauri::command]
fn pty_spawn(
    app: tauri::AppHandle,
    state: tauri::State<'_, TerminalState>,
    path: String,
    cols: u16,
    rows: u16,
) -> Result<terminal::PtySpawnResponse, String> {
    terminal::spawn(&state, &app, &path, cols, rows)
}

/// Forward user keystrokes (from xterm.js) to the PTY's stdin.
#[tauri::command]
fn pty_write(state: tauri::State<'_, TerminalState>, data: Vec<u8>) -> Result<(), String> {
    terminal::write(&state, &data)
}

/// Resize the PTY to match the xterm.js viewport.
#[tauri::command]
fn pty_resize(state: tauri::State<'_, TerminalState>, cols: u16, rows: u16) -> Result<(), String> {
    terminal::resize(&state, cols, rows)
}

/// Kill the terminal's shell and clear state. Called on panel close / repo switch.
#[tauri::command]
fn pty_kill(state: tauri::State<'_, TerminalState>) -> Result<(), String> {
    terminal::kill(&state)
}

/// Start (or replace) the filesystem watch for `path`, emitting path-tagged
/// `repo-changed` events when its worktree or git state changes. Each open
/// tab keeps its own watch; linked worktrees also cover their private gitdir
/// and shared common dir.
#[tauri::command]
fn watch_repo(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    watcher::watch(&app, &state, &path)
}

/// Stop the filesystem watch for `path` (its tab closed).
#[tauri::command]
fn unwatch_repo(state: tauri::State<'_, WatcherState>, path: String) -> Result<(), String> {
    watcher::unwatch(&state, &path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // The process plugin (cross-platform) is how the updater relaunches the app.
        .plugin(tauri_plugin_process::init())
        .manage(WatcherState::default())
        .manage(TerminalState::default())
        .manage(CloneState::default())
        .manage(SignInState::default())
        .setup(|app| {
            // Warm the login-shell PATH cache off the main thread at startup.
            // `shell::path()` resolves the user's real PATH by running a login
            // shell (`$SHELL -lic …`) on first use and caches it. The synchronous
            // `working_changes` command touches it (via LFS detection's
            // `command_on_path("git-lfs")`), so a cold cache would run that
            // login-shell probe on the webview main thread and stall the first
            // status read. Priming it here on the blocking pool means the first
            // real call hits a warm `OnceLock`.
            tauri::async_runtime::spawn_blocking(|| {
                let _ = crate::shell::path();
            });

            // The updater is desktop-only; registering it here (rather than in the
            // builder chain) keeps a future mobile build compiling without it. The
            // frontend drives it via @tauri-apps/plugin-updater.
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            // macOS app menu: replace the default with an enriched "About GitLane"
            // panel (version/author/website/license) while keeping the standard
            // Services/Hide/Quit, Edit (clipboard), and Window items. Windows/Linux
            // use our frameless custom chrome, so no native menu there.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{AboutMetadataBuilder, MenuBuilder, SubmenuBuilder};

                let about = AboutMetadataBuilder::new()
                    .name(Some("GitLane"))
                    // macOS renders "Version <version> (<short_version>)". Tauri sets
                    // CFBundleVersion == CFBundleShortVersionString, so passing both
                    // would read "0.1.0 (0.1.0)". Blank short_version to drop the
                    // redundant parenthetical build and show "Version 0.1.0" once.
                    .version(Some(env!("CARGO_PKG_VERSION")))
                    .short_version(Some(""))
                    .authors(Some(vec!["Alexander Siomkin".to_string()]))
                    .comments(Some("Visual git client for macOS"))
                    .copyright(Some("© 2026 Alexander Siomkin"))
                    .website(Some("https://gitlane.space"))
                    .website_label(Some("gitlane.space"))
                    .license(Some("GPL-3.0-or-later"))
                    .build();

                let app_menu = SubmenuBuilder::new(app, "GitLane")
                    .about(Some(about))
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;

                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;

                let window_menu = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .separator()
                    .close_window()
                    .build()?;

                let menu = MenuBuilder::new(app)
                    .items(&[&app_menu, &edit_menu, &window_menu])
                    .build()?;
                app.set_menu(menu)?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_repo,
            commit_graph,
            list_branches,
            list_worktrees,
            add_worktree,
            move_branch_to_worktree,
            delete_branch_with_worktree,
            checkout,
            create_branch,
            delete_branch,
            list_reflog,
            preview_reset,
            preview_discard_all,
            preview_delete_branch,
            preview_delete_remote_branch,
            preview_force_push,
            rename_branch,
            set_upstream,
            merge_branch,
            can_fast_forward,
            fast_forward,
            fast_forward_branch,
            rebase_onto,
            reset_to,
            cherry_pick,
            cherry_pick_many,
            revert_commit,
            revert_many,
            operation_status,
            conflict_file,
            accept_conflict_side,
            resolve_conflict_file,
            mark_conflict_resolved,
            reconflict_file,
            continue_operation,
            abort_operation,
            skip_operation,
            create_tag,
            create_annotated_tag,
            create_patch,
            delete_tag,
            delete_remote_tag,
            push_tag,
            remove_worktree,
            delete_remote_branch,
            force_push,
            discard_all,
            working_changes,
            file_diff,
            commit_files,
            read_binary_blob,
            commit_file_diff,
            diff_range,
            diff_range_file,
            selection_diff,
            selection_diff_file,
            file_history,
            file_blame,
            compare_refs,
            compare_file_diff,
            stage_file,
            unstage_file,
            apply_hunk,
            apply_line,
            stage_files,
            unstage_files,
            discard_file,
            stage_all,
            unstage_all,
            commit,
            stash,
            list_stashes,
            stash_apply,
            stash_apply_index,
            stash_branch,
            stash_pop,
            stash_drop,
            pull,
            fetch,
            push,
            push_branch,
            publish_branch,
            github_accounts,
            github_sign_in,
            cancel_github_sign_in,
            forge_auth_statuses,
            forge_account,
            repo_forge,
            list_remotes,
            add_remote,
            set_remote_url,
            remove_remote,
            list_pull_requests,
            pull_request_detail,
            pull_request_checks,
            pull_request_commits,
            pull_request_diff,
            pull_request_review_threads,
            resolve_review_thread,
            reply_review_thread,
            merge_pull_request,
            comment_pull_request,
            review_pull_request,
            set_pull_request_state,
            create_pull_request,
            set_repo_identity,
            repo_identity,
            default_git_identity,
            list_signing_keys,
            clear_repo_identity,
            clone_repo,
            cancel_clone,
            init_repo,
            recents_status,
            reveal_path,
            terminal_agents_get,
            terminal_agents_set,
            terminal_agents_reset,
            terminal_agent_probe,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            watch_repo,
            unwatch_repo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
