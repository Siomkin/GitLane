# Proposal

## Why

This is one of four per-area changes that finish PR #626's (`rust-flag-enums-and-imports`) mode-`bool` cleanup. The inventory came from a multi-line scan of `src-tauri/src`; `rust-bool-modes-misc` lists every scan row left out and why. Patch staging is not part of this set: PR #626 itself finishes `IndexSide` there.

The libgit2 diff readers in `git/status/` take mode flags. Each call reads as `file_diff(path, file, true, false)`:

- `full: bool` lifts the line cap. Five readers repeat the same `let limit = if full { usize::MAX } else { DIFF_LINE_LIMIT };`.
- `whole_file: bool` renders a file as one hunk.
- `staged: bool` picks HEAD→index versus index→worktree.

There is no Jira issue. This change touches **Rust only**: no IPC signature, wire format or frontend change.

## What Changes

- **`DiffLimit { Capped, Full }`** (in `git/status/diff.rs`, beside `DIFF_LINE_LIMIT`) replaces `full: bool` on:
  - `working::file_diff`
  - `commit::commit_file_diff`
  - `compare::compare_file_diff`
  - `range::diff_range_file`
  - `selection::selection_diff_file`

  `DiffLimit::line_limit(self) -> usize` replaces the five duplicated `if full` lines. `DiffLimit::from_full(Option<bool>)` maps `None` / `Some(false)` → `Capped` and `Some(true)` → `Full`.
- **`DiffLayout { Hunks, WholeFile }`** (in `git/status/differences.rs`) replaces `whole_file: bool` on `working_file_differences`, with `DiffLayout::from_whole_file(Option<bool>)`. The **output** field `FileDifferences.whole_file: bool` is wire data and stays as it is.
- **`IndexSide` moves to `git/types/status.rs`** (re-exported flat through `git::types`, beside `ConflictSide`), so `git::status`, a libgit2 read module, does not import from `git::write`. Only the enum and its `from_staged` move. Any inherent methods that `git::write` uses stay in `patch_staging`, and the patch-staging files change only their import lines.
- **`IndexSide`** then replaces `staged: bool` on:
  - `working::file_diff`
  - `working/new_path.rs::comparison` and `find_options`, which `file_diff` now hands the side to directly

  The internal callers (`differences.rs`, `commit.rs`, `selection.rs`, `working/new_path.rs`) pass enum values.
- **Command parameters stay as they are.** The six commands in `commands/status.rs` keep `staged: bool`, `full: Option<bool>` and `whole_file: Option<bool>`. They convert once with `IndexSide::from_staged`, `DiffLimit::from_full(full)` and `DiffLayout::from_whole_file(whole_file)`, which replace the `.unwrap_or(false)` calls. The agent's `dispatch.rs` calls those command fns, so it needs no change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. `skip_specs: true`: a pure refactor with identical behaviour and no wire change.

## Ordering

**Lands after PR #626 merges,** because #626 owns `IndexSide` and `git/write/patch_staging/`. It is independent of the forge and misc changes. If `rust-bool-modes-discard` lands first, update its `IndexSide` import too.

## Non-goals

- **`selection/blob_diff.rs::status_for(old, new)`.** These are facts about blob presence, and the helper is private with callers a few lines away. PR #626 already exempted it.
- **Changing `DIFF_LINE_LIMIT`, the `FileDiff` / `FileDifferences` wire shape, or the `full` / `whole_file` wire names.**
- **`git/forge/fixtures/pr_85_two_commits.patch`.** It contains `commit_file_diff(.., false)` as patch-fixture text. It is data and must not be edited.

## Impact

- **Code:**
  - `src-tauri/src/git/status/{diff,working,commit,compare,range,selection,differences}.rs` and `git/status/working/new_path.rs`;
  - `git/types/status.rs` (gains `IndexSide`), plus import-line edits in each `IndexSide` importer, including `git/write/patch_staging/`, `commands/staging.rs` and `git/write/tests/`;
  - `commands/status.rs`;
  - the direct callers in `git/status/tests/` (`diff.rs`, `differences.rs`, `selection.rs`, `renames.rs`, `compare_renames.rs`, `history.rs`, `intent_to_add.rs`, `stash.rs`, `working_changes.rs`), about 45 call sites.
- **Secrets / auth / IPC risk:** none. No command signature changes.
- **Pattern to copy:** `Channel::from_beta` (PR #626) for the constructor, and `IndexSide` for the shape.
