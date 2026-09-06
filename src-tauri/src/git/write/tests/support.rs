//! Shared fixtures and helpers for `git::write` integration tests.
#![allow(dead_code)]

pub(super) use super::super::branch_checkout::{
    align_equivalent_sibling, checkout, checkout_remote_branch,
};
pub(super) use super::super::branches::{
    create_branch, delete_branch, rename_branch, set_upstream,
};
pub(super) use super::super::commits::{
    commit_expected, set_squash_after_commit_test_hook, set_squash_after_read_tree_test_hook,
    squash_commits,
};
pub(super) use super::super::conflict_resolution::{
    abort_operation, accept_conflict_side, conflict_stage_absent, continue_operation,
    is_empty_after_resolution, mark_conflict_resolved, reconflict_file, resolve_conflict_file,
    skip_operation,
};
pub(super) use super::super::discard_all::{
    discard_all, preview_discard_all, set_discard_all_after_cleanup_test_hook,
    set_discard_all_after_first_clean_batch_test_hook,
    set_discard_all_after_tracked_scope_validation_test_hook,
    set_discard_all_after_validation_test_hook, set_discard_all_before_tracked_reset_test_hook,
    set_discard_all_capture_test_hook, start_discard_all_fingerprint_byte_count,
    take_discard_all_fingerprint_byte_count,
};
pub(super) use super::super::discard_file::{
    discard_file, preview_discard_file, set_discard_capture_test_hook,
};
pub(super) use super::super::files::{set_before_replace_test_hook, write_repo_file};
pub(super) use super::super::hard_reset_lease::{
    set_hard_reset_after_fingerprint_test_hook, set_hard_reset_after_validation_test_hook,
    set_hard_reset_before_mutation_test_hook, set_hard_reset_capture_test_hook,
};
pub(super) use super::super::history::{
    cherry_pick, cherry_pick_many, cherry_pick_many_onto, fast_forward, fast_forward_branch,
    fast_forward_branch_at, merge, merge_into, rebase, revert, revert_many, revert_many_onto,
};
pub(super) use super::super::identity::{clear_repo_identity, set_repo_identity};
pub(super) use super::super::lifecycle::{clone, init_in_place, CloneProgress, CloneSlot};
pub(super) use super::super::open_path::{
    ensure_diffable_against_head, open_path_default, open_path_difftool,
};
pub(super) use super::super::operands::ensure_operand;
pub(super) use super::super::patch_staging::{
    apply_hunk, apply_hunk_patch, apply_line, patch_diff_args,
};
pub(super) use super::super::patches::{
    create_patch, create_patch_range, create_working_tree_patch,
};
pub(super) use super::super::recovery::{
    preview_delete_branch, preview_delete_remote_branch, preview_force_push, preview_reset,
    reflog_entries,
};
pub(super) use super::super::remotes::{
    add_remote, branch_pull_target, branch_push_remote, delete_remote_branch, delete_remote_tag,
    fetch, force_push, head_push_remote, is_concurrent_fetch_ref_update, is_missing_remote_ref,
    is_tag_clobber_rejection, publish_branch, publish_remote, pull, pull_branch, push_branch,
    push_endpoint_token, push_target_at, set_remote_url, set_remote_username,
};
pub(super) use super::super::reset::{reset_branch, ResetRequest};
pub(super) use super::super::restore_path::{
    commit_path_is_restorable, restore_path_from_commit, worktree_differs_from_commit,
};
pub(super) use super::super::squash_range::squash_range;
pub(super) use super::super::staging::{
    stage_all, stage_files, stop_tracking, unstage_all, unstage_files,
};
pub(super) use super::super::stashes::{
    stash, stash_apply, stash_apply_index_onto, stash_apply_onto, stash_branch, stash_drop,
    stash_expected, stash_list, stash_paths, stash_pop, stash_pop_onto,
};
pub(super) use super::super::tags::{create_annotated_tag, create_tag, delete_tag};
pub(super) use super::super::worktree_removal_lease::preview_remove_worktree;
pub(super) use super::super::worktrees::{
    create_branch_in_worktree, delete_branch_with_worktree, is_porcelain_record,
    move_branch_to_worktree, remove_worktree, worktree_dirty_state, worktree_is_dirty, worktrees,
};
pub(super) use crate::git::read::repo_identity;
pub(super) use crate::git::transport_auth::{
    credential_for_remote, ProviderTokenBridge, RemoteTransportDirection, TransportCredential,
};
pub(super) use crate::git::types::{
    ApplyLineRequest, CommitRequest, ForcePushRouteLease, GitTransportAuthRef, SquashBranchRequest,
    SquashCommitsRequest, SquashRangeRequest,
};
pub(super) use crate::git::worktree_fs::set_after_guarded_rename_test_hook;
pub(super) use std::path::PathBuf;
pub(super) use std::process::Command;
pub(super) use std::sync::atomic::{AtomicU32, Ordering};

mod fixtures;
mod previews;
mod repo;
mod worktrees;

pub(super) use fixtures::*;
pub(super) use previews::*;
pub(super) use repo::*;
pub(super) use worktrees::*;

pub(super) fn squash_tip(
    repo: &str,
    expected_oid: &str,
    parent_oid: &str,
) -> Result<String, String> {
    squash_commits(
        repo,
        &SquashCommitsRequest {
            expected_branch: Some("main".into()),
            expected_oid: expected_oid.into(),
            parent_oid: parent_oid.into(),
            summary: "replacement".into(),
            description: String::new(),
            name: None,
            email: None,
            identity: crate::git::types::CapturedIdentity::NotCaptured,
        },
    )
}
