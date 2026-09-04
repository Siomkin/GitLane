//! The registration audit's runtime half.
//!
//! Its siblings read source text: they prove every `#[tauri::command]` appears
//! in `lib.rs`'s `generate_handler!` list, and that the frontend invokes only
//! names that exist. Neither can see whether a command actually *runs* — a
//! command whose `tauri::State<T>` is never `.manage()`d compiles, registers,
//! passes both text audits, and then fails the first time a user triggers it
//! with "state not managed".
//!
//! So this boots `tauri::test`'s mock runtime with the same `.manage()` calls
//! `run()` makes, and invokes those commands over the real IPC path.
//!
//! ## Why this is a subset, not the real handler list
//!
//! 22 commands declare `app: tauri::AppHandle`, which is `AppHandle<Wry>` — a
//! concrete runtime. `CommandArg` is implemented per runtime, so those
//! signatures do not satisfy `CommandArg<'_, MockRuntime>` and the real
//! `generate_handler!` list does not compile against the mock runtime at all
//! (it is all-or-nothing: one non-mockable command fails the whole list).
//!
//! Booting the real list would mean making the command layer generic over
//! `R: Runtime` — ~22 command signatures plus the impl modules behind them.
//! That is a production refactor this change deliberately did not take on.
//!
//! What this therefore proves: the listed commands resolve their managed state
//! and answer over IPC. What it does **not** prove: that `lib.rs`'s list is
//! complete — that remains the source-text audits' job — and the two
//! `AppHandle`-taking commands in this family (`watch_repo`, `pty_spawn`) have
//! no runtime coverage.

use serde_json::json;
use tauri::ipc::InvokeResponseBody;
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::WebviewWindowBuilder;

use crate::commands;
use crate::terminal::TerminalState;
use crate::watcher::WatcherState;

/// Invoke `cmd` over the IPC boundary against a mock app carrying the same
/// managed state `run()` installs.
fn invoke(cmd: &str, body: serde_json::Value) -> Result<InvokeResponseBody, serde_json::Value> {
    let app = mock_builder()
        .manage(WatcherState::default())
        .manage(TerminalState::default())
        .manage(commands::auth::OauthState::default())
        .invoke_handler(tauri::generate_handler![
            commands::repo::unwatch_repo,
            commands::terminal::pty_kill,
            commands::terminal::pty_resize,
            commands::auth::cancel_provider_oauth_sign_in,
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
            // The ACL only lets a *local* origin through, and what counts as
            // local is platform-specific (`tauri://localhost` on macOS/Linux,
            // `http://tauri.localhost` on Windows). Ask the webview rather than
            // hard-coding one and failing on the other.
            url: webview.url().expect("the mock webview has a url"),
            body: body.into(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

/// Whatever the command answered, it must not be the runtime's own complaint
/// that the command or its state does not exist.
fn assert_reached_the_command(cmd: &str, outcome: &Result<InvokeResponseBody, serde_json::Value>) {
    let Err(error) = outcome else {
        return;
    };
    let text = error.to_string();
    assert!(
        !text.contains("not found") && !text.contains("not managed"),
        "{cmd} never reached its implementation: {text}"
    );
}

#[test]
fn unwatch_repo_reaches_its_managed_watcher_state() {
    // Unwatching a path that was never watched is the side-effect-free half of
    // the watcher pair, but it still has to resolve WatcherState to answer.
    let outcome = invoke("unwatch_repo", json!({ "path": "/definitely/not/a/repo" }));

    assert_reached_the_command("unwatch_repo", &outcome);
}

#[test]
fn the_pty_commands_reach_their_managed_terminal_state() {
    // Killing a tab that was never spawned is a no-op in the terminal module,
    // so this exercises registration and state without leaving a shell behind.
    let outcome = invoke("pty_kill", json!({ "sessionId": 999u64 }));
    assert_reached_the_command("pty_kill", &outcome);
    assert!(outcome.is_ok(), "closing an absent tab is not an error");

    let outcome = invoke(
        "pty_resize",
        json!({ "sessionId": 999u64, "cols": 80, "rows": 24 }),
    );
    assert_reached_the_command("pty_resize", &outcome);
    // resize does report the missing session — but as the command's own error,
    // not as a runtime failure to reach it.
    assert!(outcome.is_err());
}

#[test]
fn cancelling_oauth_sign_in_reaches_its_managed_state() {
    // OauthState is managed for this command and its sign-in twin only, which
    // makes it the easiest one to forget to `.manage()`.
    let outcome = invoke("cancel_provider_oauth_sign_in", json!({}));

    assert_reached_the_command("cancel_provider_oauth_sign_in", &outcome);
    assert!(
        outcome.is_ok(),
        "cancelling with no sign-in in flight is a no-op: {outcome:?}"
    );
}

#[test]
fn a_command_missing_from_the_handler_list_fails_loudly() {
    // The guard the tests above rely on is only meaningful if an unregistered
    // command really does produce the error it looks for.
    let outcome = invoke("no_such_command", json!({}));

    let error = outcome.expect_err("an unregistered command must fail");
    assert!(
        error.to_string().contains("not found"),
        "expected a not-found error, got {error}"
    );
}
