//! Fast-forward, merge, rebase, cherry-pick, and revert history writes.
//!
//! Facade over the focused submodules: `fast_forward`, `merge`, `rebase`,
//! `cherry_pick`, `revert`, plus `commit_runner` (running git under the repo's
//! pinned commit identity) and `mergeness` (merge-commit detection and the
//! same-kind grouping both cherry-pick and revert need).

mod cherry_pick;
mod commit_runner;
mod fast_forward;
mod merge;
mod mergeness;
mod rebase;
mod revert;

pub use cherry_pick::{cherry_pick_many_onto, cherry_pick_onto};
pub use fast_forward::fast_forward_branch_at;
pub use merge::merge_into;
pub use rebase::rebase;
pub use revert::{revert_many_onto, revert_onto};

// Reached from sibling write modules: branch_checkout advances a branch it is
// about to check out, and patches probes merge-ness before formatting a patch.
pub(super) use fast_forward::fast_forward_branch_at_locked;
pub(super) use mergeness::is_merge_commit;

#[cfg(test)]
pub use cherry_pick::{cherry_pick, cherry_pick_many};
#[cfg(test)]
pub use fast_forward::{fast_forward, fast_forward_branch};
#[cfg(test)]
pub use merge::merge;
#[cfg(test)]
pub use revert::{revert, revert_many};
