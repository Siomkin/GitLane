## 1. Hard-reset lease

- [x] 1.1 Replace `STALE_MESSAGE` with `stale_lease()`, which returns `WriteError::stale` with the same text.
- [x] 1.2 Return `WriteError` from `validate_at_mutation_boundary` and `validate_observations`; their drift failures use `stale_lease()`.
- [x] 1.3 Pin a hard reset after the index changed in `tests/error_kinds.rs`: the typed variant and the exact `CommandError`.

## 2. Checks

- [x] 2.1 `cargo fmt --check`, clippy with `-D warnings` (desktop and agent), `cargo test` (desktop and agent) and `bun run sizes` pass. Result: 1630 desktop and 1374 agent tests, 0 failed.
