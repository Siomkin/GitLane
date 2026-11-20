# Proposal

## Why

This is one of four per-area changes that finish PR #626's (`rust-flag-enums-and-imports`) mode-`bool` cleanup. The inventory came from a multi-line scan of `src-tauri/src`; `rust-bool-modes-misc` lists every scan row left out and why. Patch staging is not part of this set: PR #626 itself finishes `IndexSide` there. It collects the remaining mode flags that do not belong to discard, status diffs or forge. Each is a few lines, and together they stay smaller than PR #626.

There is no Jira issue. This change touches **Rust only**: no IPC signature, wire format or frontend change.

## What Changes

- **Branches:** `git::write::branches::delete_branch(.., force: bool)` → `BranchDeleteMode { MergedOnly, Force }` (in `git/write/branches/delete.rs`). `MergedOnly` keeps `git branch -d`'s merged-safety check.
- **Init:** `git::write::lifecycle::init(.., readme: bool, ..)` → `Readme { Skip, Seed }` (in `git/write/lifecycle/init.rs`).
- **Conflicts:** `git::conflicts::conflict_file(.., resolved: bool)` → `ConflictStage { Unmerged, Resolved }` (in `git/conflicts/content.rs`). `Resolved` reads a conflicted file the user has already staged.
- **Worktree handoff:** `git::write::worktrees::move_branch_to_worktree(.., carry: bool, ..)` → `CarryChanges { Leave, Carry }` (in `git/write/worktrees/handoff_move.rs`).
- **Squash signing:** `squash_range::objects::commit_tree(.., sign: bool)` → `CommitSigning { Unsigned, Signed }`. `objects::signing_enabled` returns the enum directly, so `squash_range.rs` needs no conversion.
- **Discard-all digest:** `discard_all/fingerprint.rs::capture_tracked_digest(.., verify_normalized_missing: bool, ..)` → `NormalizedMissing { Skip, Verify }`. Its two callers live in sibling files (`tracked.rs`, `snapshot.rs`), and one passes a bare `false`.
- **Remote connect:** the private `commands/remote.rs::connect_to(.., announce: bool)` → `Announce { Silent, Announce }`. Its two callers, 130 and 30 lines away, pass bare `false` / `true`.
- **Command parameters stay as they are,** each converted once with a `from_*` constructor:
  - `commands/branches.rs::delete_branch` (`force: bool`) → `BranchDeleteMode::from_force`;
  - `commands/repo.rs::init_repo` (`readme: bool`) → `Readme::from_readme`;
  - `commands/conflicts.rs::conflict_file` (`resolved: Option<bool>`) → `ConflictStage::from_resolved(Option<bool>)`, which replaces `.unwrap_or(false)`;
  - `commands/worktrees.rs::move_branch_to_worktree` (`carry: bool`) → `CarryChanges::from_carry`.

  `agent/dispatch.rs` calls the command fns and needs no change.
- **`agent/run.rs` also calls `git::write::worktrees::move_branch_to_worktree` directly,** with a `carry: bool` decoded from the request. It needs the same `CarryChanges::from_carry(carry)` conversion.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. `skip_specs: true`: a pure refactor with identical behaviour and no wire change.

## Ordering

This change is independent of the other four.

## Non-goals

Every other row of the multi-line `bool`-parameter scan is out of scope, for the reason given:

- **Facts, not modes.** These describe state rather than choosing behaviour:
  - `discard_file/semantics.rs::hash_semantic_path_state(has_head)`
  - `read/branches.rs::branch_sync_state(has_remote)`
  - `commits/index_snapshot.rs::restore_index_snapshot(commit_succeeded)`
  - `hard_reset_lease/obstructions.rs::{obstructing_paths, obstruction_key, target_obstruction_paths}(case_insensitive)`, a filesystem property
  - `lifecycle/publish.rs::claim_fallback_destination(removed_existing)`
  - `watcher/classification.rs::decide_emission(throttled)`
  - `remote/askpass{,/replay}.rs::{start, serve, answer_one, decide}(replay_named)`, which is whether the local OpenSSH marks named prompts
  - `forge/bounded_output/finish.rs::finish_bytes(success, stderr_truncated)`
- **Private helpers whose callers sit a few lines away** (the guide exempts these):
  - `worktrees/lifecycle.rs::remove_worktree_validated(force, locked)`
  - `worktree_fs/handle.rs::replace_atomic_inner(require_current)`
  - `oauth/pkce/loopback.rs::write_browser_response(ok)`
  - `credentials.rs::run_git_credential(use_http_path)`
  - `selection/blob_diff.rs::status_for`
- **Data-driven or tri-state values.**
  - `auth_providers/probe.rs::probe_cli(require_output)` takes a field of the static provider-spec table. Its `(bool, Option<bool>)` return is a separate change that PR #626 already deferred.
  - `write/identity.rs::set_repo_identity(gpg_sign, tag_gpg_sign: Option<bool>)` and its `bool_arg` helper carry tri-state git-config values (unset / true / false), not modes.
- **Constructors and test helpers.** `IndexSide::from_staged`, `Channel::from_beta`, `CheckoutMode`'s and `IgnoreFile`'s converters, and the `#[cfg(test)]` `ApplyLineRequest::test`.
- **Covered elsewhere.** Discard, status diffs and forge each have their own change. `git/write/patch_staging/` (`apply_hunk`, `apply_hunk_patch`, the extractors' `reverse`) is finished in PR #626 itself.

## Impact

- **Code:**
  - `src-tauri/src/git/write/branches/delete.rs`, `git/write/lifecycle/init.rs`, `git/conflicts/content.rs` and `git/write/worktrees/handoff_move.rs`;
  - `git/write/squash_range.rs` and `squash_range/objects.rs`;
  - `git/write/discard_all/{fingerprint,tracked,snapshot}.rs`;
  - `commands/{branches,repo,conflicts,worktrees,remote}.rs`;
  - `agent/run.rs`;
  - the tests: `git/write/tests/branches/{delete,delete_claims,delete_preview}.rs`, `git/write/tests/worktrees/{handoff,handoff_dirty,list}.rs`, `git/write/tests/support{,/worktrees}.rs`, `git/conflicts/tests.rs`, any `init` test callers, and `remote/connect.rs`'s test only if it touches `connect_to` (it calls `askpass::start`, which stays as it is).
- **Overlap:** `rust-typed-write-errors` touches `git/write/lifecycle/init.rs` and `commands/repo.rs`. The edits here change one parameter type each, so whichever lands second rebases trivially.
- **Secrets / auth / IPC risk:** none. No command signature changes. `connect_to` keeps its askpass and host-key behaviour, and only the type of `announce` changes.
- **Pattern to copy:** `CheckoutMode` and `Channel::from_beta` from PR #626.
