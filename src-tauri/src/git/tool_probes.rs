//! The external-tool probes — git's version gate, `gh` and `origin` capability
//! detection, `glab` presence — cached process-wide but bounded by explicit
//! invalidation rather than the process lifetime (`ipc/commands` spec:
//! "External tool availability is re-checked without restart").
//!
//! Each probe is a [`ProbeCell`]: `RwLock<Option<_>>` that caches only a
//! *successful* detection, so a transient failure (tool briefly unavailable)
//! is never sticky and the hot path stays one probe per invalidation. The cells
//! are cleared by the `refresh_tool_probes` command (the frontend calls it on
//! account changes and explicit retries) and, per tool, by the subprocess
//! boundary that sees a `NotFound` spawn error — a cached success for a binary
//! that has since gone is the one stale state worth dropping eagerly.
//!
//! One shared instance, [`TOOL_PROBES`], rather than `tauri::State`: the probes
//! are read from deep inside the write layer and the forge providers, which
//! have no `AppHandle`, and threading one through every git call site would
//! be a far larger change than the cache it serves.

use std::sync::{PoisonError, RwLock};

use crate::git::forge::{GhCapabilities, OriginCapabilities};

/// One cached probe result. Empty until a probe succeeds; cleared by
/// [`ProbeCell::invalidate`].
pub struct ProbeCell<T>(RwLock<Option<T>>);

impl<T: Clone> ProbeCell<T> {
    pub const fn new() -> Self {
        Self(RwLock::new(None))
    }

    /// The cached result, or run `probe` and cache its success. A failure
    /// propagates uncached so the next call probes again. Two first callers
    /// racing may both probe; the later write wins, which is harmless because
    /// both detected the same tool.
    pub fn get_or_probe<E>(&self, probe: impl FnOnce() -> Result<T, E>) -> Result<T, E> {
        if let Some(cached) = self
            .0
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            return Ok(cached.clone());
        }
        let detected = probe()?;
        *self.0.write().unwrap_or_else(PoisonError::into_inner) = Some(detected.clone());
        Ok(detected)
    }

    /// Drop the cached result so the next [`get_or_probe`](Self::get_or_probe)
    /// re-detects the tool. Idempotent; never probes itself.
    pub fn invalidate(&self) {
        *self.0.write().unwrap_or_else(PoisonError::into_inner) = None;
    }

    #[cfg(test)]
    pub fn is_cached(&self) -> bool {
        self.0
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    }
}

/// The four tool probes GitLane keeps.
pub struct ToolProbes {
    /// `git --version` passed the 2.36 gate (`git/write/cli/version.rs`).
    pub git: ProbeCell<()>,
    /// `gh` version + capability baseline (`git/forge/cli/capabilities.rs`).
    pub gh: ProbeCell<GhCapabilities>,
    /// `glab --version` succeeded (`git/forge/gitlab/transport.rs`).
    pub glab: ProbeCell<()>,
    /// `origin` capability baseline (`git/forge/origin/capabilities.rs`).
    pub origin: ProbeCell<OriginCapabilities>,
}

impl ToolProbes {
    pub const fn new() -> Self {
        Self {
            git: ProbeCell::new(),
            gh: ProbeCell::new(),
            glab: ProbeCell::new(),
            origin: ProbeCell::new(),
        }
    }

    /// Forget every cached probe — the `refresh_tool_probes` command. The next
    /// operation on each tool re-detects it.
    pub fn invalidate_all(&self) {
        self.git.invalidate();
        self.gh.invalidate();
        self.glab.invalidate();
        self.origin.invalidate();
    }
}

/// The process-wide probe cache every tool boundary reads.
pub static TOOL_PROBES: ToolProbes = ToolProbes::new();

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    /// A prober that counts its runs and answers from a script, so the tests
    /// never depend on a real binary.
    fn counting<'a, T: Clone>(
        runs: &'a Cell<u32>,
        answer: impl Fn(u32) -> Result<T, String> + 'a,
    ) -> impl FnMut() -> Result<T, String> + 'a {
        move || {
            runs.set(runs.get() + 1);
            answer(runs.get())
        }
    }

    #[test]
    fn probes_once_then_serves_the_cache_until_invalidated() {
        let cell = ProbeCell::<u32>::new();
        let runs = Cell::new(0);

        assert_eq!(cell.get_or_probe(counting(&runs, |n| Ok(n * 10))), Ok(10));
        assert_eq!(cell.get_or_probe(counting(&runs, |n| Ok(n * 10))), Ok(10));
        assert_eq!(runs.get(), 1, "a cached success must not re-probe");
        assert!(cell.is_cached());

        cell.invalidate();
        assert!(!cell.is_cached());
        assert_eq!(cell.get_or_probe(counting(&runs, |n| Ok(n * 10))), Ok(20));
        assert_eq!(runs.get(), 2, "invalidation re-probes exactly once");
    }

    #[test]
    fn a_failed_probe_is_never_sticky() {
        let cell = ProbeCell::<()>::new();
        let runs = Cell::new(0);
        let flaky = |n: u32| {
            if n == 1 {
                Err("not found".to_string())
            } else {
                Ok(())
            }
        };

        assert_eq!(
            cell.get_or_probe(counting(&runs, flaky)),
            Err("not found".to_string())
        );
        assert!(!cell.is_cached(), "a failure must not be cached");
        assert_eq!(cell.get_or_probe(counting(&runs, flaky)), Ok(()));
        assert_eq!(runs.get(), 2);
        assert!(cell.is_cached());
    }

    #[test]
    fn invalidate_is_idempotent_on_an_empty_cell() {
        let cell = ProbeCell::<()>::new();
        cell.invalidate();
        cell.invalidate();
        assert!(!cell.is_cached());
    }

    #[test]
    fn invalidate_all_clears_every_tool() {
        let probes = ToolProbes::new();
        let _ = probes.git.get_or_probe(|| Ok::<_, String>(()));
        let _ = probes.glab.get_or_probe(|| Ok::<_, String>(()));
        assert!(probes.git.is_cached() && probes.glab.is_cached());

        probes.invalidate_all();

        assert!(!probes.git.is_cached());
        assert!(!probes.gh.is_cached());
        assert!(!probes.glab.is_cached());
        assert!(!probes.origin.is_cached());
    }
}
