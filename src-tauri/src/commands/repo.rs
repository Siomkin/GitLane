//! Repository lifecycle: open, graph/history reads, clone/init, recents, and the filesystem watch.

use super::{blocking, sync, CommandError};
use crate::git::types::{
    BranchInfo, GitTransportAuthRef, HistorySearchPage, HistorySearchQuery, HistorySearchResult,
    RecentStatus, RepoGraph, RepoSummary,
};
use crate::watcher::WatcherState;
use crate::{git, shell, watcher};

/// Holds the in-flight `git clone` child so [`cancel_clone`] can terminate it
/// from another command while the clone streams progress. The inner [`Arc`] is
/// cloned out before the clone runs on the blocking pool.
#[derive(Default)]
pub struct CloneState(git::write::lifecycle::CloneSlot);

/// Initial graph window. The frontend explicitly increases this in 2,000-commit
/// pages while virtualized rows/canvas keep rendering memory bounded.
const DEFAULT_GRAPH_LIMIT: usize = 2000;

#[tauri::command]
pub fn open_repo(path: String) -> Result<RepoSummary, CommandError> {
    // `RepoOpenError` converts into `CommandError` with `kind` missingPath /
    // notARepository and the attempted `path`, so the frontend can tell a
    // moved/deleted repository apart from a real failure and offer the
    // dedicated missing-repo state with Remove / Locate / Retry (GL-108).
    sync(|| git::read::summary_classified(&path))
}

#[tauri::command]
pub async fn commit_graph(path: String, limit: Option<usize>) -> Result<RepoGraph, CommandError> {
    let limit = limit.unwrap_or(DEFAULT_GRAPH_LIMIT);
    // Large histories can spend hundreds of milliseconds in ref collection,
    // revwalk, lane layout, and serialization. Open the non-Send Repository
    // inside the worker closure so none of that blocks the webview thread.
    blocking(move || git::read::commit_graph(&path, limit).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn search_history(
    path: String,
    query: HistorySearchQuery,
) -> Result<HistorySearchPage, CommandError> {
    blocking(move || git::read::search_history(&path, query)).await
}

#[tauri::command]
pub async fn suggest_tree_paths(
    path: String,
    filter: String,
    limit: Option<usize>,
) -> Result<Vec<String>, CommandError> {
    // The HEAD tree walk is proportional to the repo's file count — keep it
    // off the webview thread like the other potentially expensive reads.
    blocking(move || git::read::suggest_tree_paths(&path, &filter, limit)).await
}

#[tauri::command]
pub fn list_branches(path: String) -> Result<Vec<BranchInfo>, CommandError> {
    sync(|| git::read::branches(&path).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn can_fast_forward(path: String, from: String, to: String) -> Result<bool, CommandError> {
    sync(|| git::read::can_fast_forward(&path, &from, &to).map_err(|e| e.to_string()))
}

/// The commits `base..head` would carry, newest first.
#[tauri::command]
pub async fn range_commits(
    path: String,
    base: String,
    head: String,
) -> Result<Vec<HistorySearchResult>, CommandError> {
    blocking(move || git::read::range_commits(&path, &base, &head)).await
}

/// Which of `candidates` `head` descends from, nearest first.
#[tauri::command]
pub async fn ancestor_refs(
    path: String,
    head: String,
    candidates: Vec<String>,
) -> Result<Vec<String>, CommandError> {
    blocking(move || git::read::ancestor_refs(&path, &head, &candidates)).await
}

/// The branch a new pull request from `head` should target by default.
#[tauri::command]
pub async fn default_base_branch(
    path: String,
    head: String,
) -> Result<Option<String>, CommandError> {
    blocking(move || git::read::default_base_branch(&path, &head)).await
}

/// Clone `url` into `dest`, streaming `clone-progress` events as it runs. The
/// child is parked in [`CloneState`] so [`cancel_clone`] can stop it. Returns the
/// cloned path on success; the frontend then opens it.
#[tauri::command]
pub async fn clone_repo(
    app: tauri::AppHandle,
    state: tauri::State<'_, CloneState>,
    url: String,
    dest: String,
    auth: Option<GitTransportAuthRef>,
) -> Result<String, CommandError> {
    let slot = state.0.clone();
    blocking(move || {
        let cred = git::transport_auth::credential_for_url(&url, auth.as_ref())?;
        // A dropped progress tick must never fail the clone itself.
        let progress = |p: &git::write::lifecycle::CloneProgress| {
            crate::events::emit(&app, crate::events::CLONE_PROGRESS, p.clone());
        };
        git::write::lifecycle::clone(&progress, slot, &url, &dest, &cred)
    })
    .await
}

/// Terminate an in-flight [`clone_repo`]. Instant (lock + kill), so it stays a
/// plain sync command and never queues behind the blocking pool the clone holds.
#[tauri::command]
pub fn cancel_clone(state: tauri::State<'_, CloneState>) -> Result<(), CommandError> {
    sync(|| git::write::lifecycle::cancel_clone(&state.0))
}

/// Initialize a new repository at `parent`/`name` on `branch`, optionally seeding
/// a README and a `.gitignore` template. Returns the new repo's path.
#[tauri::command]
pub async fn init_repo(
    parent: String,
    name: String,
    branch: String,
    readme: bool,
    gitignore: String,
) -> Result<String, CommandError> {
    blocking(move || git::write::lifecycle::init(&parent, &name, &branch, readme, &gitignore)).await
}

/// Initialize an already-existing, possibly non-empty directory as a git
/// repository in place — the missing-repo screen's "Initialize as git repo"
/// recovery action for a folder that lost its `.git` (GL-153).
#[tauri::command]
pub async fn init_repo_in_place(path: String) -> Result<String, CommandError> {
    blocking(move || git::write::lifecycle::init_in_place(&path)).await
}

/// Presence + current branch for each recent repo path, so the onboarding list
/// can flag missing paths and show branches. Touches the filesystem per path, so
/// it runs off the main thread.
#[tauri::command]
pub async fn recents_status(paths: Vec<String>) -> Result<Vec<RecentStatus>, CommandError> {
    blocking(move || Ok::<_, CommandError>(git::read::recents_status(&paths))).await
}

/// Reveal `path` in the OS file manager (Finder/Explorer). Spawns and returns
/// immediately, so a plain sync command is fine.
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), CommandError> {
    sync(|| shell::reveal(&path))
}

/// Start (or replace) the filesystem watch for `path`, emitting path-tagged
/// `repo-changed` events when its worktree or git state changes. Each open
/// tab keeps its own watch; linked worktrees also cover their private gitdir
/// and shared common dir.
#[tauri::command]
pub async fn watch_repo(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<(), CommandError> {
    // Repository discovery plus recursive notify registration touches the
    // filesystem and may be slow on network/large worktrees. WatcherState is
    // Arc-backed so setup can run off the webview thread while callbacks retain
    // the same registry ownership.
    let state = state.inner().clone();
    blocking(move || watcher::watch(&app, &state, &path)).await
}

/// Stop the filesystem watch for `path` (its tab closed).
#[tauri::command]
pub async fn unwatch_repo(
    state: tauri::State<'_, WatcherState>,
    path: String,
) -> Result<(), CommandError> {
    // Recursive watch setup briefly holds the shared registry while installing
    // a replacement. Keep tab-close teardown off the webview thread so it
    // cannot freeze the UI while waiting for that lock.
    let state = state.inner().clone();
    blocking(move || watcher::unwatch(&state, &path)).await
}
