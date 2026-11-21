## 1. Discard all

- [x] 1.1 Replace `STALE_MESSAGE` with `lease::stale_lease()`, and build the nested-repository failures with `WriteError::stale`.
- [x] 1.2 Return `WriteError` from the mutation path (facade, snapshot, tracked, cleanup, nested, fingerprint); non-lease messages become `WriteError::Git` with unchanged text.
- [x] 1.3 Replace the re-capture's text matching (`== CAPTURE_DRIFT`, `ends_with(STALE_SUFFIX)`) with a private `StableCapture` enum.
- [x] 1.4 Pin a Discard all after the tree changed in `tests/error_kinds.rs`: the typed variant and the exact `CommandError`.

## 2. Review follow-ups

- [x] 2.1 Return `WriteError` from `ensure_exact_oid` and `reset_to_oid`; pin a reset to a ref name in `tests/error_kinds.rs`.
- [x] 2.2 Add `lease::after_cleanup` and use it where a typed failure is reworded after cleanup ran; unit-test it.
- [x] 2.3 Build the worktree-removal lease with `WriteError::stale`.
- [x] 2.4 Test drift between the two recapture passes at the mutation boundary (checked by breaking the `Drift` arm: the test fails).

## 3. Checks

- [x] 3.1 `cargo fmt --check`, clippy with `-D warnings` (desktop and agent), `cargo test` (desktop and agent) and `bun run sizes` pass. Result: 1635 desktop and 1379 agent tests, 0 failed.
