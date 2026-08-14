//! Local branch creation, deletion, and tracking writes.
//!
//! Facade over the focused submodules: `refs` (resolving and validating the ref
//! a write targets), `create` (create, rename, set upstream), `delete` (the
//! guarded deletion and its config cleanup), and `deletion_transaction` (the
//! `git update-ref --stdin` compare-and-swap both deletion paths share).

mod create;
mod delete;
mod deletion_transaction;
mod refs;

pub use create::{create_branch, rename_branch, set_upstream};
pub use delete::delete_branch;

// Reached from sibling write modules: the worktree flow and recovery drive the
// same deletion primitives, and history/recovery resolve refs through these.
pub(super) use delete::{
    deleted_branch_message, ensure_branch_not_checked_out, ensure_branch_ref_is_direct,
};
pub(super) use deletion_transaction::prepare_branch_deletion;
pub(super) use refs::{checked_branch_ref, qualify_branch_if_ambiguous, ref_exists, resolve_rev};
