# Tasks

## 1. Rust impl: `DiffLimit`

- [x] 1.1 Add `#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum DiffLimit { Capped, Full }` in `git/status/diff.rs` with two functions:
  - `pub fn from_full(full: Option<bool>) -> Self`
  - `pub fn line_limit(self) -> usize`, returning `DIFF_LINE_LIMIT` or `usize::MAX`
- [x] 1.2 Take `DiffLimit` in place of `full: bool` in `working::file_diff`, `commit::commit_file_diff`, `compare::compare_file_diff`, `range::diff_range_file` and `selection::selection_diff_file`. Replace each `let limit = if full { .. }` with `limit.line_limit()`, and update the doc comments that mention `full`.

## 2. Rust impl: `DiffLayout` and `IndexSide`

- [x] 2.1 Once PR #626 has merged, move the `IndexSide` enum and `from_staged` to `git/types/status.rs`, keeping the doc comments. Leave any inherent methods that `git::write` uses (such as `done_verb`) in `patch_staging`. Remove the `patch_staging` re-export, and point every importer (`grep -rn 'IndexSide' src-tauri/src`) at `crate::git::types::IndexSide`; in `git/write/patch_staging/` only the import lines change. Verify with `cargo check`.
- [x] 2.2 Add `DiffLayout { Hunks, WholeFile }` with `from_whole_file(Option<bool>)` in `git/status/differences.rs`, and take it in `working_file_differences`. The returned `FileDifferences.whole_file` stays a `bool` (`shown_whole`).
- [x] 2.3 Take `IndexSide` in place of `staged: bool` in `working::file_diff`, `working/new_path.rs::comparison` and `working/new_path.rs::find_options`, matching on the side.
- [x] 2.4 Update the internal callers to pass enum values: `differences.rs` (`file_diff(path, file, IndexSide::Staged, DiffLimit::Capped)` …), `commit.rs`, `selection.rs` and `working.rs`.

## 3. Command layer: keep the wire types

- [x] 3.1 In `commands/status.rs`, make the six commands (`file_diff`, `working_file_differences`, `commit_file_diff`, `diff_range_file`, `compare_file_diff`, `selection_diff_file`) convert once with `IndexSide::from_staged(staged)`, `DiffLimit::from_full(full)` and `DiffLayout::from_whole_file(whole_file)`. Parameter names and types stay as they are. Verify that `cargo test registration` still passes unchanged.
- [x] 3.2 Add a unit test in the existing `#[cfg(test)] mod tests` of `commands/status.rs` pinning the conversions:
  - `DiffLimit::from_full` for `None`, `Some(false)` and `Some(true)`;
  - `DiffLayout::from_whole_file` for the same three;
  - `DiffLimit::line_limit` for both variants.

## 4. Tests

- [x] 4.1 Update the direct callers under `git/status/tests/` (`diff.rs`, `differences.rs`, `selection.rs`, `renames.rs`, `compare_renames.rs`, `history.rs`, `intent_to_add.rs`, `stash.rs`, `working_changes.rs`) to pass enum values. Do not touch `git/forge/fixtures/pr_85_two_commits.patch`. Verify with `cargo test status`.

## 5. Definition of done

- [x] 5.1 `(cd src-tauri && cargo fmt --all -- --check)` passes.
- [x] 5.2 `(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings)` and `(cd src-tauri && cargo clippy --all-targets --no-default-features --features agent -- -D warnings)` pass.
- [x] 5.3 `(cd src-tauri && cargo test)` passes with no change to any existing test's expected output.
- [x] 5.4 `bun run sizes` passes.
