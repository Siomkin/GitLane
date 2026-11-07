//! Which connect attempt each host's `Connected` state belongs to, so the
//! end of a session is announced only for the session the tab is showing.
//!
//! A session closed during its own connect (a version or protocol mismatch)
//! is reported as that connect's `Failed`; its reader thread must not follow
//! with `Disconnected`. Nor may an old session's late close overwrite a newer
//! session's `Connected`. Both announcements run under one lock, so they can
//! never be emitted out of order.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

pub struct Announced {
    next: AtomicU64,
    live: Mutex<BTreeMap<String, u64>>,
}

impl Announced {
    pub const fn new() -> Self {
        Self {
            next: AtomicU64::new(1),
            live: Mutex::new(BTreeMap::new()),
        }
    }

    /// A fresh id for one connect attempt.
    pub fn attempt(&self) -> u64 {
        self.next.fetch_add(1, Ordering::Relaxed)
    }

    /// Make `id` the attempt `origin` shows as connected, running `emit` (the
    /// `Connected` announcement) under the lock.
    pub fn connected(&self, origin: &str, id: u64, emit: impl FnOnce()) {
        let mut live = self.live.lock().unwrap_or_else(|p| p.into_inner());
        live.insert(origin.to_string(), id);
        emit();
    }

    /// Attempt `id`'s session ended: run `emit` (the `Disconnected`
    /// announcement) only if it is still the one `origin` shows as connected.
    /// Runs at most once per `connected`.
    pub fn ended(&self, origin: &str, id: u64, emit: impl FnOnce()) {
        let mut live = self.live.lock().unwrap_or_else(|p| p.into_inner());
        if live.get(origin) == Some(&id) {
            live.remove(origin);
            emit();
        }
    }
}

#[cfg(test)]
mod tests;
