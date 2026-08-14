//! Linked-worktree operations backed by git porcelain.
//!
//! Facade over the focused submodules: listing (`list`), path comparison
//! (`paths`), the dirty/ignored probe (`dirty`), handoff stashing (`stash`),
//! create/remove/validate (`lifecycle`), and moving a branch between worktrees
//! (`handoff_move`).

mod dirty;
mod handoff_move;
mod lifecycle;
mod list;
mod paths;
mod stash;

pub use dirty::{worktree_dirty_state, worktree_is_dirty};
pub use handoff_move::move_branch_to_worktree;
pub use lifecycle::{
    add_worktree, create_branch_in_worktree, delete_branch_with_worktree, remove_worktree,
};
pub use list::worktrees;

pub(super) use dirty::is_porcelain_record;
pub(super) use paths::worktree_git_dir;
pub(super) use stash::drop_stash_by_oid;

#[cfg(test)]
mod tests {
    use super::stash::unique_stash_message;

    #[test]
    fn handoff_stash_messages_are_unique_for_identical_attempts() {
        let first = unique_stash_message("GitLane: handoff feature");
        let second = unique_stash_message("GitLane: handoff feature");

        assert_ne!(first, second);
        assert!(first.starts_with("GitLane: handoff feature [GitLane attempt "));
        assert!(second.starts_with("GitLane: handoff feature [GitLane attempt "));
    }
}
