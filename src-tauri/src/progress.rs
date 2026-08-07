//! App-shell adapters that carry backend progress to the webview (GL-355).
//!
//! The backend's streaming writes report through a `ProgressSink`, which knows
//! nothing about Tauri; this is the one place that turns those reports into
//! webview events. Keeping it here — rather than inside `git::write` — is what
//! lets the write layer be exercised without an `AppHandle`.

use tauri::{AppHandle, Emitter};

use crate::git::write::{CloneProgress, ProgressSink};

/// Emits clone progress as the `clone-progress` event the onboarding UI listens
/// for. A failed emit is ignored: the clone itself is the operation, and a
/// dropped progress tick must never fail it.
pub struct CloneProgressEvents<'a>(pub &'a AppHandle);

impl ProgressSink for CloneProgressEvents<'_> {
    fn emit(&self, progress: &CloneProgress) {
        let _ = self.0.emit("clone-progress", progress.clone());
    }
}
