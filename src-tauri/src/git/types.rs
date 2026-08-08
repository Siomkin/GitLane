//! Serializable types shared across the Rust <-> frontend (IPC) boundary.
//!
//! Everything here is the data the React layer consumes; keep field names in
//! sync with `src/lib/api/*.ts`.
//!
//! The declarations live in focused modules under `types/`, one per domain, and
//! are re-exported flat from here (GL-341) — so every caller keeps writing
//! `crate::git::types::Foo` regardless of which module owns `Foo`.

mod auth;
mod conflicts;
mod diff;
mod files;
mod forge;
mod graph;
mod preview;
mod refs;
mod repo;
mod status;
mod worktree;

pub use auth::*;
pub use conflicts::*;
pub use diff::*;
pub use files::*;
pub use forge::*;
pub use graph::*;
pub use preview::*;
pub use refs::*;
pub use repo::*;
pub use status::*;
pub use worktree::*;
