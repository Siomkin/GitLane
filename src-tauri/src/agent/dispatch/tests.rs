use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::{camel, dispatch, is_remote_capable, Progress};
use crate::commands;

/// A repository with one commit and one modified tracked file, removed on drop.
struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("gitlane-agent-dispatch-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let repo = git2::Repository::init(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("a.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("GitLane", "gitlane@example.test").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "first", &tree, &[])
            .unwrap();
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        Fixture(dir)
    }

    fn path(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn run<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(future)
}

fn no_progress() -> Progress {
    Arc::new(|_, _| {})
}

fn via_table(command: &str, args: Value) -> Value {
    run(dispatch(command, &args, no_progress())).unwrap()
}

#[test]
fn table_matches_the_direct_command_call() {
    let repo = Fixture::new();
    let path = repo.path();

    let direct = run(commands::repo::open_repo(path.clone())).unwrap();
    assert_eq!(
        via_table("open_repo", json!({ "path": path })),
        serde_json::to_value(direct).unwrap()
    );

    let direct = run(commands::repo::commit_graph(path.clone(), Some(50))).unwrap();
    assert_eq!(
        via_table("commit_graph", json!({ "path": path, "limit": 50 })),
        serde_json::to_value(direct).unwrap()
    );

    let direct = run(commands::status::working_changes(path.clone())).unwrap();
    let table = via_table("working_changes", json!({ "path": path }));
    assert_eq!(table, serde_json::to_value(direct).unwrap());
    assert!(
        table.to_string().contains("a.txt"),
        "the modified file is reported: {table}"
    );
}

#[test]
fn optional_arguments_may_be_omitted_and_names_are_camel_case() {
    let repo = Fixture::new();
    // `limit` omitted reads as `None`, like a Tauri invoke without it.
    let graph = via_table("commit_graph", json!({ "path": repo.path() }));
    assert!(graph.get("commits").is_some(), "{graph}");

    assert_eq!(camel("expected_source_oid"), "expectedSourceOid");
    assert_eq!(camel("path"), "path");
}

#[test]
fn a_bad_argument_is_an_error_not_a_panic() {
    let err = run(dispatch(
        "commit_graph",
        &json!({ "path": 7 }),
        no_progress(),
    ))
    .unwrap_err();
    assert!(err.message.contains("`path`"), "{err:?}");
}

#[test]
fn local_only_commands_are_refused() {
    assert!(!is_remote_capable("save_provider_token"));
    assert!(!is_remote_capable("pty_spawn"));
    assert!(is_remote_capable("open_repo"));
    assert!(is_remote_capable("move_branch_to_worktree"));
    assert!(is_remote_capable("watch_repo"));

    let err = run(dispatch(
        "reveal_path",
        &json!({ "path": "/" }),
        no_progress(),
    ))
    .unwrap_err();
    assert!(err.message.contains("not available"), "{err:?}");
}

#[test]
fn progress_commands_report_through_the_sink() {
    let repo = Fixture::new();
    let seen: Arc<Mutex<Vec<&'static str>>> = Arc::default();
    let sink = seen.clone();
    let progress: Progress = Arc::new(move |name, _| sink.lock().unwrap().push(name));
    // A branch that does not exist fails validation; any step reported before
    // that uses the hand-off event name, and the call returns an error, not a panic.
    let result = run(dispatch(
        "move_branch_to_worktree",
        &json!({
            "path": repo.path(),
            "branch": "missing",
            "fromWorktreePath": repo.path(),
            "toWorktreePath": repo.path(),
            "carry": false,
        }),
        progress,
    ));
    assert!(result.is_err());
    assert!(seen
        .lock()
        .unwrap()
        .iter()
        .all(|name| *name == crate::events::HANDOFF_PROGRESS));
}

#[test]
fn watch_reports_changes_as_repo_changed_until_unwatched() {
    let repo = Fixture::new();
    let path = repo.path();
    let seen: Arc<Mutex<Vec<(&'static str, Value)>>> = Arc::default();
    let sink = seen.clone();
    let progress: Progress =
        Arc::new(move |name, payload| sink.lock().unwrap().push((name, payload)));

    run(dispatch("watch_repo", &json!({ "path": path }), progress)).unwrap();
    std::fs::write(repo.0.join("a.txt"), "changed on the server\n").unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while seen.lock().unwrap().is_empty() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let events = seen.lock().unwrap().clone();
    assert!(!events.is_empty(), "no repo-changed within 5s");
    assert_eq!(events[0].0, crate::events::REPO_CHANGED);
    assert_eq!(events[0].1["path"], json!(path));

    run(dispatch(
        "unwatch_repo",
        &json!({ "path": path }),
        no_progress(),
    ))
    .unwrap();
}

#[test]
fn a_watch_that_cannot_be_installed_is_an_error() {
    let missing = std::env::temp_dir().join("gitlane-agent-watch-no-such-dir");
    let err = run(dispatch(
        "watch_repo",
        &json!({ "path": missing }),
        no_progress(),
    ))
    .unwrap_err();
    assert!(!err.message.is_empty(), "{err:?}");
}
