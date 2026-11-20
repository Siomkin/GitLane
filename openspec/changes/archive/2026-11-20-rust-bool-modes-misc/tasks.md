# Tasks

Each new enum is `#[derive(Debug, Clone, Copy, PartialEq, Eq)]` with no serde, next to its function.

## 1. Rust impl: command-backed functions

- [x] 1.1 Add `BranchDeleteMode { MergedOnly, Force }` with `from_force(bool)` in `git/write/branches/delete.rs`, and take it in `delete_branch` (`if !force` → `if mode == BranchDeleteMode::MergedOnly`). Update the doc comment, and the callers in `git/write/tests/branches/{delete,delete_claims,delete_preview}.rs` and `git/write/tests/support.rs`. Verify with `cargo test branches`.
- [x] 1.2 Add `Readme { Skip, Seed }` with `from_readme(bool)` in `git/write/lifecycle/init.rs`, and take it in `init`. Update any test callers (`grep -rn 'lifecycle::init\|init(' src-tauri/src/git/write/tests`). Verify with `cargo test lifecycle`.
- [x] 1.3 Add `ConflictStage { Unmerged, Resolved }` with `from_resolved(Option<bool>)` in `git/conflicts/content.rs`, and take it in `conflict_file`. Update the doc comment and the 10 calls in `git/conflicts/tests.rs`. Verify with `cargo test conflicts`.
- [x] 1.4 Add `CarryChanges { Leave, Carry }` with `from_carry(bool)` in `git/write/worktrees/handoff_move.rs`, and take it in `move_branch_to_worktree`. Update `git/write/tests/worktrees/{handoff,handoff_dirty,list}.rs` and `git/write/tests/support/worktrees.rs`. Verify with `cargo test worktrees`.

## 2. Rust impl: internal functions

- [x] 2.1 Add `CommitSigning { Unsigned, Signed }` in `git/write/squash_range/objects.rs`. Make `signing_enabled` return `Result<CommitSigning, String>` and `commit_tree` take it. `squash_range.rs` passes it through unchanged. Verify with `cargo test squash`.
- [x] 2.2 Add `NormalizedMissing { Skip, Verify }` in `git/write/discard_all/fingerprint.rs`, and take it in `capture_tracked_digest`. Update `discard_all/tracked.rs` and `discard_all/snapshot.rs` (the bare `false` → `NormalizedMissing::Skip`). Verify with `cargo test discard_all`.
- [x] 2.3 Add a private `Announce { Silent, Announce }` in `commands/remote.rs`, and take it in `connect_to`. The two callers pass `Announce::Silent` (the Test connection) and `Announce::Announce`. Verify with `cargo check` and `cargo test remote`.

## 3. Command layer: keep the wire types

- [x] 3.1 Convert once in each command, leaving parameter names and types unchanged:
  - `commands/branches.rs::delete_branch` → `BranchDeleteMode::from_force(force)`;
  - `commands/repo.rs::init_repo` → `Readme::from_readme(readme)`;
  - `commands/conflicts.rs::conflict_file` → `ConflictStage::from_resolved(resolved)`, replacing `.unwrap_or(false)`;
  - `commands/worktrees.rs::move_branch_to_worktree` → `CarryChanges::from_carry(carry)`.

  Verify that `cargo test registration` still passes unchanged.
- [x] 3.2 In `agent/run.rs`, convert the decoded `carry: bool` with `CarryChanges::from_carry(carry)` before calling `git::write::worktrees::move_branch_to_worktree`. Verify with `(cd src-tauri && cargo clippy --all-targets --no-default-features --features agent -- -D warnings)`.
- [x] 3.3 Add unit tests pinning both mappings of each constructor: `BranchDeleteMode::from_force`, `Readme::from_readme` and `CarryChanges::from_carry`, plus `ConflictStage::from_resolved` for `None`, `Some(false)` and `Some(true)`. Put each beside its enum's existing tests (`git/write/tests/branches/delete.rs`, `git/conflicts/tests.rs`, `git/write/tests/worktrees/handoff.rs`, and the `init` tests).

## 4. Definition of done

- [x] 4.1 `(cd src-tauri && cargo fmt --all -- --check)` passes.
- [x] 4.2 `(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings)` and `(cd src-tauri && cargo clippy --all-targets --no-default-features --features agent -- -D warnings)` pass.
- [x] 4.3 `(cd src-tauri && cargo test)` passes with no change to any existing test's expected output.
- [x] 4.4 `bun run sizes` passes.
