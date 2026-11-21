## 1. Reset

- [x] 1.1 Return `WriteError` from `ResetRequest::parse`, `reset_to` and `reset_branch`; build the two lease failures with `WriteError::stale`.
- [x] 1.2 Unit-test that both `parse` lease failures are `WriteError::StaleLease` and that a branch without its oid stays `WriteError::Git`.

## 2. Force-push

- [x] 2.1 Return `WriteError` from `force_push`, `validate_force_push_route` and the route check; build the four route failures with `WriteError::stale`.
- [x] 2.2 Pin the pushRemote and destination drift tests to `WriteError::StaleLease`.

## 3. Checks

- [x] 3.1 `cargo fmt --check`, clippy with `-D warnings` (desktop and agent), `cargo test` (desktop and agent) and `bun run sizes` pass. Result: 1627 desktop and 1371 agent tests, 0 failed.
