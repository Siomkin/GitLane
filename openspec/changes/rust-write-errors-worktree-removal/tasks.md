## 1. Worktree removal lease

- [x] 1.1 Return `WriteError` from `validate_removal_lease`: lease loss is `StaleLease` (text unchanged), other capture failures are `Git`.
- [x] 1.2 Reword the `StaleLease` doc: the message contains the suffix.
- [x] 1.3 Assert the variants in `tests/recovery/worktree_lease.rs`, and pin a foreign lease token in `tests/error_kinds.rs`.

## 2. Checks

- [x] 2.1 `cargo fmt --check`, clippy with `-D warnings` (desktop and agent), `cargo test` (desktop and agent) and `bun run sizes` pass. Result: 1631 desktop and 1375 agent tests, 0 failed.
