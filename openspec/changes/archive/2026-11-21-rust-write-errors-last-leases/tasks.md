## 1. Branch delete

- [x] 1.1 In `git/write/branches/delete.rs`, return `WriteError` from `ensure_branch_ref_is_direct` and `delete_branch`, and build the symbolic-ref failure with `WriteError::stale`. Leave the `String` callers in `recovery/branches.rs` and `worktrees/lifecycle.rs` converting with `?`. Verify with `cargo check --all-targets`.
- [x] 1.2 Pin a delete of a branch whose ref became symbolic in `tests/error_kinds.rs`: the typed `StaleLease` and the exact `CommandError`. Verify with `cargo test error_kinds`.

## 2. Patch staging

- [x] 2.1 In `git/write/patch_staging/extract.rs`, return `WriteError` from `find_hunk`, `extract_single_hunk_patch` and `extract_single_line_patch`. Build their six lease failures with `WriteError::stale`; keep "Patch-level staging is unavailable for this file" as `WriteError::Git`.
- [x] 2.2 In `patch_staging/range.rs`, return `WriteError` from `extract_line_range_patch`, `apply_line_range` and `revert_line_range`, with its two lease failures built by `WriteError::stale`. Keep the `Err(_) => break` hunk walk as it is.
- [x] 2.3 In `patch_staging/apply.rs`, return `WriteError` from `apply_hunk` and `apply_line`. Verify with `cargo check --all-targets`.
- [x] 2.4 Pin a stale hunk (the diff changed after the frontend read it) in `tests/error_kinds.rs`: the typed `StaleLease` and the exact `CommandError`. Verify with `cargo test error_kinds staging`.

## 3. Remote checkout

- [x] 3.1 In `git/write/branch_checkout.rs`, make `retry_failure` return `WriteError::stale(..)` and `checkout_remote_branch` return `WriteError`. Turn `retry_failure_classifies_as_a_stale_lease` into a variant assertion and keep the other `retry_failure` tests passing on the message text. Verify with `cargo test branch_checkout`.

## 4. Checks

- [x] 4.1 `grep -rn 'classify::stale' src-tauri/src/git/write` finds no producer outside tests and `classify.rs` itself. With no producer left, `classify::stale` is `#[cfg(test)]`: only the classify tests use it, to pin the text fallback.
- [x] 4.2 `cargo fmt --check`, clippy with `-D warnings` (desktop and agent), `cargo test` (desktop and agent) and `bun run sizes` pass. Result: 1637 desktop and 1381 agent tests, 0 failed.
