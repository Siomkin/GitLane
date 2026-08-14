//! The single sign-in slot: the child process it owns, the progress events
//! it emits, and the debug log behind them.

use std::sync::{Arc, Mutex};

use portable_pty::Child;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// One sign-in milestone, emitted to the frontend as a `github-signin-progress`
/// event. `code`/`url` are present only on the initial `"code"` step.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SignInProgress {
    /// `"code"` | `"browser"` | `"authorized"`.
    step: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
}

/// Shared slot for the in-flight sign-in: the running child (so [`cancel_sign_in`]
/// can kill it) plus a sticky `canceled` flag. The flag closes a race — a Cancel
/// can land in the window between [`sign_in_web`] being dispatched and its spawn
/// registering the child, when there is no child to kill yet; the flag lets the
/// spawn abort before it launches gh (and a browser) after the UI backed out.
#[derive(Default)]
pub struct SignInSlotState {
    pub(super) child: Option<Box<dyn Child + Send + Sync>>,
    pub(super) canceled: bool,
}

pub type SignInSlot = Arc<Mutex<SignInSlotState>>;

/// Dev-only diagnostics on the `tauri dev` stderr, for debugging the interactive
/// flow. The raw gh output includes the (short-lived) one-time device code, so
/// these must never log in release builds.
pub(super) fn debug_log(args: std::fmt::Arguments<'_>) {
    #[cfg(debug_assertions)]
    eprintln!("[signin] {args}");
    #[cfg(not(debug_assertions))]
    let _ = args;
}

pub(super) fn emit(app: &AppHandle, step: &str, code: Option<String>, url: Option<String>) {
    let _ = app.emit(
        "github-signin-progress",
        SignInProgress {
            step: step.to_string(),
            code,
            url,
        },
    );
}
