//! The single sign-in slot: the child process it owns, the progress it reports,
//! and the debug log behind them.

use std::sync::{Arc, Mutex};

use portable_pty::Child;

use crate::events::SignInProgress;

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
    crate::log::debug!("[signin] {args}");
}

/// Where the sign-in reports its milestones. The reader thread holds a clone, so
/// it is shared and thread-safe; the command layer forwards each one to the
/// webview as `github-signin-progress`.
pub type SignInProgressSink = Arc<dyn Fn(&SignInProgress) + Send + Sync>;

pub(super) fn emit(
    progress: &dyn Fn(&SignInProgress),
    step: &str,
    code: Option<String>,
    url: Option<String>,
) {
    progress(&SignInProgress {
        step: step.to_string(),
        code,
        url,
    });
}
