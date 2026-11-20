# Tasks

## 1. Rust impl: mode enums

- [x] 1.1 Add `#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum CheckoutMode { Branch, Detached }` in `git/write/branch_checkout.rs` and take it in `checkout`. Update its callers in `git/write/branch_checkout.rs` and the tests under `git/write/tests/` (`branch_checkout/*`, `discard/worktree.rs`, `history/merge.rs`). Verify with `cargo test branch_checkout`.
- [x] 1.2 Add `IgnoreFile { Gitignore, InfoExclude }` in `git/write/ignore.rs` and take it in `append_ignore_pattern`. Update the doc comment that currently explains `local = true/false` and the 10 in-file test calls. Verify with `cargo test ignore`.
- [x] 1.3 Add `Channel { Stable, Beta }` in `updater.rs`. Take it in `endpoint_for`, `check` and `release_notes`, and in the two `updater/release_notes.rs` helpers (`fetch`, `select`). Update `updater/tests.rs`. Verify with `cargo test updater`.
- [x] 1.4 Add `PlusSign { Literal, Space }` in `percent.rs` and take it in `decode_lossy`. Update `git/oauth/pkce/loopback.rs`, `redact.rs` and the `percent.rs` tests. Verify with `cargo test percent`.
- [x] 1.5 Add `IndexSide { Staged, Unstaged }` in `git/write/patch_staging/runners.rs` and take it in `patch_diff_args`. Update `patch_staging/{apply,range}.rs` and `git/write/tests/staging/hunks.rs`. Verify with `cargo test staging`.

## 2. Command layer: keep the wire `bool`

- [x] 2.1 In `commands/branches.rs::checkout`, `commands/staging.rs::append_ignore_pattern` and `commands/updater.rs` (both commands), keep the `bool` parameter and convert it in one line (`if detached { CheckoutMode::Detached } else { CheckoutMode::Branch }`). Verify that `commands/registration_tests` still passes unchanged: `cargo test registration`.

## 3. Rust impl: explicit imports

- [x] 3.1 Replace `use super::super::dto::*;` in `git/forge/prs/{commits,merge,mutations,reads,stacks}.rs` with the explicit `use super::super::dto::{..};` list each file needs. Verify with `grep -rn 'dto::\*' src-tauri/src` (no hits) and `cargo check`.

## 4. Definition of done

- [x] 4.1 `(cd src-tauri && cargo fmt --all -- --check)` passes.
- [x] 4.2 `(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings)` and `cargo clippy --all-targets --no-default-features --features agent -- -D warnings` pass.
- [x] 4.3 `(cd src-tauri && cargo test)` passes with no change to any test's expected output.
- [x] 4.4 `bun run sizes` passes.
