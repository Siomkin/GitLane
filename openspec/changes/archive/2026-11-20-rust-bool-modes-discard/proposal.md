# Proposal

## Why

This is one of four per-area changes that finish what PR #626 (`rust-flag-enums-and-imports`) started: replacing mode-selecting `bool` parameters with enums. The inventory came from a multi-line scan of `src-tauri/src`; `rust-bool-modes-misc` lists every scan row left out and why. Patch staging is not part of this set: PR #626 itself finishes `IndexSide` there.

Per-file discard threads `staged: bool` through five functions. The flag picks which row the user is discarding:

- the **staged** row, which restores both the index and the worktree;
- the **unstaged** row, which restores the worktree from the index.

That is exactly `IndexSide`. At the call site, `capture_discard_snapshot(repo, file, previous, true)` hides that choice.

There is no Jira issue. This change touches **Rust only**: no IPC signature, wire format or frontend change.

## What Changes

- **`IndexSide` replaces `staged: bool`** on:
  - `git::write::discard_file::preview_discard_file` and `discard_file` (both `pub`);
  - `discard_file/snapshot.rs::capture_discard_snapshot`;
  - `discard_file/semantics.rs::capture_discard_semantics` and `source_entry_matches` (all `pub(super)`, called from sibling files).
- **The expected-state fingerprint stays byte-identical.** `semantics.rs` hashes `u8::from(staged)` into the discard fingerprint. It becomes `u8::from(side == IndexSide::Staged)`, so a preview taken before the change still matches.
- **Command parameters stay `bool`.** `commands/staging.rs::preview_discard_file` and `discard_file` keep their wire `staged: bool` and convert once with `IndexSide::from_staged(staged)`. The agent's `dispatch.rs` calls those command fns, so it needs no change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. `skip_specs: true`: a pure refactor with identical behaviour and no wire change.

## Ordering

**Lands after PR #626 merges** (it owns `IndexSide`). Import `IndexSide` from wherever it lives at that point: `git::write::patch_staging`, or `git::types` if `rust-bool-modes-status-diffs` has already moved it. Otherwise independent of the other changes.

## Non-goals

- **`hash_semantic_path_state(.., has_head)`.** `has_head` records a fact about the repository (whether HEAD exists). It does not select a mode.
- **`discard_all/*`.** Its `capture_tracked_digest(verify_normalized_missing)` is covered by `rust-bool-modes-misc`.
- **Any change to discard semantics, messages or the fingerprint format.**

## Impact

- **Code:**
  - `src-tauri/src/git/write/discard_file/{discard,snapshot,semantics}.rs`;
  - `commands/staging.rs`;
  - `git/write/tests/discard/{file,preview,rename,retarget,worktree}.rs` and `git/write/tests/support/previews.rs`.
- **Overlap:** `rust-typed-write-errors` names `discard_file/discard.rs` and `commands/staging.rs`. These edits touch only parameter types, so whichever lands second rebases trivially.
- **Secrets / auth / IPC risk:** none. No command signature changes. The fingerprint is a safety lease against destructive discards, so task 1.3 pins its byte.
- **Pattern to copy:** `apply_hunk` in PR #626. The command converts with `IndexSide::from_staged` and the impl takes `IndexSide`.
