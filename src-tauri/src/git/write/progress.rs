//! Where a streaming write reports its progress (GL-355).
//!
//! Clone is the app's one streaming write, and it used to report progress by
//! taking a `tauri::AppHandle` and emitting on it. That made `lifecycle.rs` the
//! only module under `write/` that knew about the app shell — and, because an
//! `AppHandle` cannot be built in a unit test, it made [`super::clone`] itself
//! unreachable: every clone test had to stop at the pure helpers around it.
//!
//! A sink is the seam. Production passes the Tauri emitter (`crate::progress`);
//! tests pass [`RecordingSink`] and then assert on the events the clone actually
//! produced, including the ones the streaming loop derives from git's stderr.

use super::CloneProgress;

/// Somewhere for a long write to report how far along it is.
pub trait ProgressSink {
    fn emit(&self, progress: &CloneProgress);
}

/// Collects everything emitted, in order, so a test can assert on the progress
/// a real clone reported rather than only on the parser that shaped it.
#[cfg(test)]
#[derive(Default)]
pub struct RecordingSink(std::sync::Mutex<Vec<CloneProgress>>);

#[cfg(test)]
impl RecordingSink {
    pub fn events(&self) -> Vec<CloneProgress> {
        self.0.lock().unwrap().clone()
    }

    /// The stage labels, in order — usually the interesting part.
    pub fn stages(&self) -> Vec<String> {
        self.events().into_iter().map(|p| p.stage).collect()
    }
}

#[cfg(test)]
impl ProgressSink for RecordingSink {
    fn emit(&self, progress: &CloneProgress) {
        self.0.lock().unwrap().push(progress.clone());
    }
}
