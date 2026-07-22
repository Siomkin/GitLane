//! Mutating git operations.
//!
//! These intentionally shell out to the user's real `git` binary rather than
//! using libgit2. The CLI honours hooks, credential helpers, `.gitconfig`,
//! signing, and the full conflict machinery — all of which libgit2 wrappers
//! reimplement only partially. This module is the public facade used by the IPC
//! layer; focused siblings own subprocess execution, operand validation, branch
//! checkout, branch and history writes, tags and patch creation, resets,
//! commit/amend/squash writes, conflict resolution, guarded file discard, patch
//! and bulk staging, stash/worktree porcelain, remotes, recovery previews, and
//! repo identity.

mod branch_checkout;
mod branches;
mod cli;
mod commits;
mod conflict_resolution;
mod discard_all;
mod discard_file;
mod files;
mod hard_reset_lease;
mod head;
mod history;
mod identity;
mod lifecycle;
mod operands;
mod patch_staging;
mod patches;
mod recovery;
mod remotes;
mod reset;
mod staging;
mod stashes;
mod tags;
#[cfg(test)]
mod tests;
mod worktree_removal_lease;
mod worktrees;

pub use branch_checkout::{checkout, checkout_remote_branch};
pub use branches::{create_branch, delete_branch, rename_branch, set_upstream};
#[cfg(test)]
pub use commits::commit;
pub use commits::{commit_expected, squash_commits};
pub use conflict_resolution::{
    abort_operation, accept_conflict_side, continue_operation, mark_conflict_resolved,
    reconflict_file, resolve_conflict_file, skip_operation,
};
pub use discard_all::{discard_all, preview_discard_all};
#[cfg(test)]
pub(crate) use discard_all::{
    set_discard_all_after_cleanup_test_hook, set_discard_all_after_first_clean_batch_test_hook,
    set_discard_all_after_tracked_scope_validation_test_hook,
    set_discard_all_after_validation_test_hook, set_discard_all_before_tracked_reset_test_hook,
    set_discard_all_capture_test_hook, start_discard_all_fingerprint_byte_count,
    take_discard_all_fingerprint_byte_count,
};
#[cfg(test)]
pub(crate) use discard_file::set_discard_capture_test_hook;
pub use discard_file::{discard_file, preview_discard_file};
#[cfg(test)]
pub(crate) use files::set_before_replace_test_hook;
pub use files::write_repo_file;
#[cfg(test)]
pub(crate) use hard_reset_lease::{
    set_hard_reset_after_fingerprint_test_hook, set_hard_reset_after_validation_test_hook,
    set_hard_reset_before_mutation_test_hook, set_hard_reset_capture_test_hook,
};
#[cfg(test)]
pub use history::{
    cherry_pick, cherry_pick_many, fast_forward, fast_forward_branch, merge, revert, revert_many,
};
pub use history::{
    cherry_pick_many_onto, cherry_pick_onto, fast_forward_branch_at, merge_into, rebase,
    revert_many_onto, revert_onto,
};
pub use identity::{clear_repo_identity, set_repo_identity};
pub use lifecycle::{cancel_clone, clone, init, init_in_place, CloneSlot};
pub use patch_staging::{apply_hunk, apply_line};
pub use patches::create_patch;
pub use recovery::{
    preview_delete_branch, preview_delete_remote_branch, preview_force_push, preview_reset,
    reflog_entries,
};
pub use remotes::{
    add_remote, branch_pull_target, branch_push_remote, delete_remote_branch, delete_remote_tag,
    fetch, force_push, publish_branch, publish_remote, pull_branch, push_branch, push_tag,
    remove_remote, set_remote_url, set_remote_username, validate_force_push_route,
};
#[cfg(test)]
pub use remotes::{head_push_remote, pull};
pub use reset::reset_branch;
pub use staging::{stage_all, stage_file, stage_files, unstage_all, unstage_file, unstage_files};
#[cfg(test)]
pub use stashes::{stash, stash_apply, stash_pop};
pub use stashes::{
    stash_apply_index_onto, stash_apply_onto, stash_branch, stash_drop, stash_expected, stash_list,
    stash_pop_onto,
};
pub use tags::{create_annotated_tag, create_tag, delete_tag};
pub use worktree_removal_lease::preview_remove_worktree;
pub use worktrees::{
    add_worktree, create_branch_in_worktree, delete_branch_with_worktree, move_branch_to_worktree,
    remove_worktree, worktree_dirty_state, worktree_is_dirty, worktrees,
};
