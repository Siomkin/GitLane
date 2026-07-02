//! Mutating git operations.
//!
//! These intentionally shell out to the user's real `git` binary rather than
//! using libgit2. The CLI honours hooks, credential helpers, `.gitconfig`,
//! signing, and the full conflict machinery — all of which libgit2 wrappers
//! reimplement only partially. This module is the public facade used by the IPC
//! layer; focused siblings own subprocess execution, operand validation, branch
//! writes, conflict resolution, staging, stash/worktree porcelain, remotes,
//! recovery previews, and repo identity.

mod branches;
mod cli;
mod conflict_resolution;
mod identity;
mod lifecycle;
mod operands;
mod recovery;
mod remotes;
mod staging;
mod stashes;
#[cfg(test)]
mod tests;
mod worktrees;

pub use branches::{
    checkout, cherry_pick, cherry_pick_many, create_annotated_tag, create_branch, create_patch,
    create_tag, delete_branch, delete_tag, fast_forward, fast_forward_branch, merge, rebase,
    rename_branch, reset, revert, revert_many, set_upstream,
};
pub use lifecycle::{cancel_clone, clone, init, CloneSlot};
pub use conflict_resolution::{
    abort_operation, accept_conflict_side, continue_operation, mark_conflict_resolved,
    reconflict_file, resolve_conflict_file, skip_operation,
};
pub use identity::{clear_repo_identity, set_repo_identity};
pub use recovery::{
    preview_delete_branch, preview_delete_remote_branch, preview_discard_all, preview_force_push,
    preview_reset, reflog_entries,
};
pub use remotes::{
    add_remote, delete_remote_branch, delete_remote_tag, fetch, force_push, publish_branch, pull,
    push, push_branch, push_tag, remove_remote, set_remote_url,
};
pub use staging::{
    apply_hunk, apply_line, commit, discard_all, discard_file, stage_all, stage_file, stage_files,
    unstage_all, unstage_file, unstage_files,
};
pub use stashes::{
    stash, stash_apply, stash_apply_index, stash_branch, stash_drop, stash_list, stash_pop,
};
pub use worktrees::{
    add_worktree, delete_branch_with_worktree, move_branch_to_worktree, remove_worktree, worktrees,
};
