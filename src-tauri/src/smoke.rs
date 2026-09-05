//! The one end-to-end smoke path: open a repository, stage a file, commit it,
//! and read the graph back — each step going through the real IPC boundary
//! rather than a mocked `invoke`.
//!
//! Everything else in the suite tests one side of the wire. The frontend tests
//! mock `@tauri-apps/api/core`; the Rust tests call implementation functions
//! directly. Neither notices if a command is registered under a different name,
//! deserializes its payload differently than the caller serializes it, or fails
//! to round-trip its result. This does.
//!
//! ## Why `tauri::test` and not WebDriver
//!
//! The two candidates were `tauri-driver` + WebDriver, and a Rust test booting
//! the handler list via `tauri::test`. This is the second. WebDriver would also
//! cover the webview — real clicks on real DOM — but needs `webkit2gtk-driver`
//! on the Linux runner, is unverified on macOS, and adds a browser-automation
//! dependency and its flakiness to every CI run. `tauri::test` needs no display
//! server, runs in the existing `cargo test` invocation, and costs seconds.
//!
//! What it therefore does not cover: the webview, the JS wrappers in
//! `src/lib/api`, and any command taking `tauri::AppHandle` (see
//! `commands/registration_tests/runtime.rs` for why those cannot boot against
//! `MockRuntime`). It covers the command layer, the serde boundary, and the git
//! implementation underneath, against a real repository on disk.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::json;
use tauri::ipc::InvokeResponseBody;
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::WebviewWindowBuilder;

use crate::commands;

/// A throwaway repository that cleans itself up on drop — same
/// dependency-free shape the git write tests use.
struct TempRepo(PathBuf);

impl TempRepo {
    fn new() -> Self {
        static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("gitlane-smoke-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let repo = TempRepo(dir);
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "smoke@test.invalid"]);
        repo.git(&["config", "user.name", "Smoke Test"]);
        // The developer's global config signs by default; a test repo has no key.
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo
    }

    fn git(&self, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.0)
            .args(args)
            .output()
            .expect("git launches in tests");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn path(&self) -> &str {
        self.0.to_str().unwrap()
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The commands this path needs. A subset by necessity, not by choice —
/// `generate_handler!` is all-or-nothing and the full list contains commands
/// taking `AppHandle<Wry>`, which `MockRuntime` cannot satisfy.
fn invoke(cmd: &str, body: serde_json::Value) -> Result<InvokeResponseBody, serde_json::Value> {
    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![
            commands::repo::open_repo,
            commands::repo::commit_graph,
            commands::staging::stage_files,
            commands::commits::commit,
            commands::commits::squash_branch,
            commands::status::working_changes,
        ])
        .build(mock_context(noop_assets()))
        .expect("the mock app builds");
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("mock webview builds");
    get_ipc_response(
        &webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            // Local origin only — see runtime.rs; the form is platform-specific.
            url: webview.url().expect("the mock webview has a url"),
            body: body.into(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

fn ok(cmd: &str, body: serde_json::Value) -> serde_json::Value {
    match invoke(cmd, body) {
        Ok(InvokeResponseBody::Json(text)) => serde_json::from_str(&text).unwrap_or(json!(null)),
        Ok(InvokeResponseBody::Raw(bytes)) => json!(bytes.len()),
        Err(error) => panic!("{cmd} failed over IPC: {error}"),
    }
}

fn write(dir: &Path, name: &str, body: &str) {
    std::fs::write(dir.join(name), body).unwrap();
}

#[test]
fn open_stage_commit_and_read_the_graph_over_ipc() {
    let repo = TempRepo::new();
    write(&repo.0, "hello.txt", "first\n");

    // 1. Open — the summary crosses the boundary as camelCase JSON.
    let summary = ok("open_repo", json!({ "path": repo.path() }));
    assert_eq!(summary["headBranch"], "main");
    // An unborn HEAD has no commit yet.
    assert!(summary["headOid"].is_null(), "summary: {summary}");
    let path = summary["path"]
        .as_str()
        .expect("a normalized path")
        .to_string();

    // 2. The working tree reports the untracked file.
    let changes = ok("working_changes", json!({ "path": path }));
    let unstaged = changes["unstaged"].as_array().expect("unstaged list");
    assert!(
        unstaged.iter().any(|f| f["path"] == "hello.txt"),
        "expected hello.txt untracked, got {changes}"
    );

    // 3. Stage it.
    ok(
        "stage_files",
        json!({ "path": path, "files": ["hello.txt"] }),
    );
    let changes = ok("working_changes", json!({ "path": path }));
    assert!(
        changes["staged"]
            .as_array()
            .expect("staged list")
            .iter()
            .any(|f| f["path"] == "hello.txt"),
        "expected hello.txt staged, got {changes}"
    );

    // 4. Commit it. `identity` is a tagged enum on the Rust side, so this also
    //    exercises the serde representation the frontend has to produce.
    ok(
        "commit",
        json!({
            "path": path,
            "expectedBranch": "main",
            "expectedOid": null,
            "summary": "Add hello",
            "description": "",
            "amend": false,
            "name": null,
            "email": null,
            "identity": { "mode": "notCaptured" },
        }),
    );

    // 5. Read the graph back — the commit is there, with its lane assigned.
    let graph = ok("commit_graph", json!({ "path": path, "limit": 50 }));
    let commits = graph["commits"].as_array().expect("commit list");
    assert_eq!(commits.len(), 1, "graph: {graph}");
    assert_eq!(commits[0]["summary"], "Add hello");
    assert_eq!(commits[0]["lane"], 0);
    assert!(
        commits[0]["refs"]
            .as_array()
            .expect("refs")
            .iter()
            .any(|r| r.to_string().contains("main")),
        "the new commit carries the branch ref: {}",
        commits[0]
    );
    assert_eq!(graph["head"], commits[0]["id"]);

    // And the working tree is clean again.
    let changes = ok("working_changes", json!({ "path": path }));
    assert!(changes["staged"].as_array().unwrap().is_empty());
    assert!(changes["unstaged"].as_array().unwrap().is_empty());
}

#[test]
fn opening_a_directory_that_is_not_a_repository_fails_with_a_typed_error() {
    // The error contract crosses the same boundary: a CommandError with a
    // `kind` the frontend switches on, not a bare string.
    // Not inside a TempRepo: `Repository::discover` walks *up*, so a directory
    // nested in one would resolve to that parent repository and succeed.
    let plain = std::env::temp_dir().join(format!("gitlane-smoke-plain-{}", std::process::id()));
    std::fs::create_dir_all(&plain).unwrap();

    let error = invoke("open_repo", json!({ "path": plain.to_str().unwrap() }))
        .expect_err("a plain directory is not a repository");
    let _ = std::fs::remove_dir_all(&plain);

    let text = error.to_string();
    assert!(
        text.contains("kind"),
        "expected a typed CommandError: {text}"
    );
}

#[test]
fn squash_another_branch_over_ipc_preserves_dirty_head() {
    let repo = TempRepo::new();
    write(&repo.0, "hello.txt", "base");
    repo.git(&["add", "."]);
    repo.git(&["commit", "-qm", "base"]);
    let repository = git2::Repository::open(&repo.0).unwrap();
    let base = repository.head().unwrap().target().unwrap().to_string();
    repo.git(&["switch", "-c", "feature"]);
    for message in ["one", "two"] {
        write(&repo.0, "hello.txt", message);
        repo.git(&["add", "."]);
        repo.git(&["commit", "-qm", message]);
    }
    let tip = repository.head().unwrap().target().unwrap().to_string();
    repo.git(&["switch", "main"]);
    write(&repo.0, "hello.txt", "staged");
    repo.git(&["add", "."]);
    write(&repo.0, "hello.txt", "unstaged");
    write(&repo.0, "loose.txt", "untracked");
    let index = std::fs::read(repo.0.join(".git/index")).unwrap();
    let payload = json!({
        "path": repo.path(), "expectedBranch": "feature", "expectedOid": tip,
        "newestOid": tip, "parentOid": base, "summary": "folded", "description": "",
        "name": null, "email": null, "identity": { "mode": "notCaptured" },
    });
    let result = ok("squash_branch", payload.clone());
    let feature = repository
        .find_reference("refs/heads/feature")
        .unwrap()
        .target()
        .unwrap();
    assert_eq!(result.as_str().unwrap(), feature.to_string());
    let commit = repository.find_commit(feature).unwrap();
    assert_eq!(commit.parent_id(0).unwrap().to_string(), base);
    assert_eq!(commit.summary().unwrap(), Some("folded"));
    assert_eq!(
        repository.head().unwrap().name().unwrap(),
        "refs/heads/main"
    );
    assert_eq!(
        repository.head().unwrap().target().unwrap().to_string(),
        base
    );
    assert_eq!(std::fs::read(repo.0.join(".git/index")).unwrap(), index);
    assert_eq!(
        std::fs::read_to_string(repo.0.join("hello.txt")).unwrap(),
        "unstaged"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("loose.txt")).unwrap(),
        "untracked"
    );
    let stale = invoke("squash_branch", payload).expect_err("a reused lease is stale");
    assert!(stale.to_string().contains("changed"));
}
