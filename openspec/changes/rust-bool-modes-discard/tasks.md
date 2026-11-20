# Tasks

## 1. Rust impl: take `IndexSide`

- [x] 1.1 In `git/write/discard_file/discard.rs`, take `side: IndexSide` in place of `staged: bool` in `preview_discard_file` and `discard_file`. Replace `if staged` / `None if staged` with matches on `side`, and update the doc comments.
- [x] 1.2 In `discard_file/snapshot.rs::capture_discard_snapshot` and `discard_file/semantics.rs::{capture_discard_semantics, source_entry_matches}`, take `IndexSide`. Keep the `"staged"` / `"unstaged"` message strings identical.
- [x] 1.3 In `semantics.rs`, replace `state.update([u8::from(staged)])` with `state.update([u8::from(side == IndexSide::Staged)])`, so the fingerprint bytes do not change.

## 2. Command layer: keep the wire `bool`

- [x] 2.1 In `commands/staging.rs::{preview_discard_file, discard_file}`, keep `staged: bool` and pass `IndexSide::from_staged(staged)`. Verify that `cargo test registration` still passes unchanged.
- [x] 2.2 Add a `#[cfg(test)]` test in `commands/staging.rs`, following the `block_on` pattern in `commands/status.rs`. It calls the `preview_discard_file` command on a fixture repository with a staged and an unstaged change to the same file:
  - `staged: true` yields the staged summary ("Unstage and discard …");
  - `staged: false` yields "Discard unstaged changes in …".

  This pins the wire-bool-to-side conversion.

## 3. Tests

- [x] 3.1 Update the direct callers in `git/write/tests/discard/{file,preview,rename,retarget,worktree}.rs` and `git/write/tests/support/previews.rs` to pass `IndexSide::Staged` / `IndexSide::Unstaged`. Verify with `cargo test discard`.

## 4. Definition of done

- [x] 4.1 `(cd src-tauri && cargo fmt --all -- --check)` passes.
- [x] 4.2 `(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings)` and `(cd src-tauri && cargo clippy --all-targets --no-default-features --features agent -- -D warnings)` pass.
- [x] 4.3 `(cd src-tauri && cargo test)` passes with no change to any existing test's expected output.
- [x] 4.4 `bun run sizes` passes.
