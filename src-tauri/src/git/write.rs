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
mod files;
mod head;
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
    checkout, checkout_remote_branch, cherry_pick_many_onto, cherry_pick_onto,
    create_annotated_tag, create_branch, create_patch, create_tag, delete_branch, delete_tag,
    fast_forward_branch_at, merge_into, rebase, rename_branch, reset_branch, revert_many_onto,
    revert_onto, set_upstream,
};
#[cfg(test)]
pub use branches::{
    cherry_pick, cherry_pick_many, fast_forward, fast_forward_branch, merge, reset, revert,
    revert_many,
};
pub use conflict_resolution::{
    abort_operation, accept_conflict_side, continue_operation, mark_conflict_resolved,
    reconflict_file, resolve_conflict_file, skip_operation,
};
#[cfg(test)]
pub(crate) use files::set_before_replace_test_hook;
pub use files::write_repo_file;
pub use identity::{clear_repo_identity, set_repo_identity};
pub use lifecycle::{cancel_clone, clone, init, init_in_place, CloneSlot};
pub use recovery::{
    preview_delete_branch, preview_delete_remote_branch, preview_discard_all, preview_force_push,
    preview_reset, reflog_entries,
};
pub use remotes::{
    add_remote, branch_pull_target, branch_push_remote, delete_remote_branch, delete_remote_tag,
    fetch, force_push, publish_branch, publish_remote, pull_branch, push_branch, push_tag,
    remove_remote, set_remote_url, set_remote_username,
};
#[cfg(test)]
pub use remotes::{head_push_remote, pull};
#[cfg(test)]
pub(crate) use staging::set_discard_capture_test_hook;
pub use staging::{
    apply_hunk, apply_line, commit_expected, discard_all, discard_file, preview_discard_file,
    squash_commits, stage_all, stage_file, stage_files, unstage_all, unstage_file, unstage_files,
};
#[cfg(test)]
pub use stashes::{stash, stash_apply, stash_pop};
pub use stashes::{
    stash_apply_index_onto, stash_apply_onto, stash_branch, stash_drop, stash_expected, stash_list,
    stash_pop_onto,
};
pub use worktrees::{
    add_worktree, create_branch_in_worktree, delete_branch_with_worktree, move_branch_to_worktree,
    remove_worktree, worktree_dirty_state, worktree_is_dirty, worktrees,
};
