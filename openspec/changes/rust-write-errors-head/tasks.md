## 1. Head leases

- [x] 1.1 Return `WriteError` from `ensure_revision_at`, `ensure_expected_head`, `ensure_expected_branch_tip` and `checkout_expected_branch`; build their three lease failures with `WriteError::stale`.
- [x] 1.2 Return `WriteError` from `reset`'s `prepare_hard_reset_subject`.
- [x] 1.3 Pin a reset of a moved branch tip in `tests/error_kinds.rs`: the typed variant and the exact `CommandError`.

## 2. Checks

- [x] 2.1 `cargo fmt --check`, clippy with `-D warnings` (desktop and agent), `cargo test` (desktop and agent) and `bun run sizes` pass. Result: 1628 desktop and 1372 agent tests, 0 failed.
