//! Exact-state lease for destructive hard resets (GL-302).
//!
//! Soft/mixed resets keep working-tree content; hard reset does not. The
//! confirmation therefore captures repository scope, HEAD, index, and worktree
//! fingerprints, then the write re-captures and compares before any mutation.
//!
//! Facade over the focused submodules: `scope` (the leased repository scope),
//! `fingerprint` (what it hashes), `obstructions` (what the target would
//! overwrite), `capture` (taking and re-checking the snapshot), and `hooks`
//! (the test-only windows).

mod capture;
mod fingerprint;
mod hooks;
mod obstructions;
mod scope;

pub(super) use capture::{capture, ensure_source_is_checked_out, validate_at_mutation_boundary};
pub(super) use obstructions::preview_untracked_obstructions;
// Only the write-path tests name this; the reset itself gets a ValidatedScope
// back from validate_at_mutation_boundary without naming its type.
pub(super) use hooks::{run_after_validation_test_hook, run_before_mutation_test_hook};
#[cfg(test)]
pub(super) use scope::describe_lease_error;

#[cfg(test)]
pub(crate) use hooks::{
    set_hard_reset_after_fingerprint_test_hook, set_hard_reset_after_validation_test_hook,
    set_hard_reset_before_mutation_test_hook, set_hard_reset_capture_test_hook,
};
