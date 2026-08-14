//! Guarded single-file discard previews and writes.

mod discard;
mod hash;
mod hooks;
mod semantics;
mod snapshot;

pub use discard::{discard_file, preview_discard_file};

#[cfg(test)]
pub(crate) use hooks::set_discard_capture_test_hook;
