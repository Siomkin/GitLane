## 1. Discard all

- [x] 1.1 Replace `STALE_MESSAGE` with `lease::stale_lease()`, and build the nested-repository failures with `WriteError::stale`.
- [x] 1.2 Return `WriteError` from the mutation path (facade, snapshot, tracked, cleanup, nested, fingerprint); non-lease messages become `WriteError::Git` with unchanged text.
- [x] 1.3 Replace the re-capture's text matching (`== CAPTURE_DRIFT`, `ends_with(STALE_SUFFIX)`) with a private `StableCapture` enum.
- [x] 1.4 Pin a Discard all after the tree changed in `tests/error_kinds.rs`: the typed variant and the exact `CommandError`.

## 2. Checks

- [x] 2.1 `cargo fmt --check`, clippy with `-D warnings` (desktop and agent), `cargo test` (desktop and agent) and `bun run sizes` pass. Result: 1632 desktop and 1376 agent tests, 0 failed.
