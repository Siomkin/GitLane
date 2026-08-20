## 1. Origin Checks and Review Data

- [x] 1.1 Add focused Origin DTO child modules for check results and submitted reviews, deserializing permissively (unknown enum values must not fail the payload), with status, verdict, and dismissal normalization tests over camelCase fixtures.
- [x] 1.2 Add the pinned `origin pr checks <number> --json name,status,conclusion,group -R <repo>` operation, wire `OriginProvider::pr_checks`, and test exact arguments, the `group / name` label when `group` is present, the empty-`[]` case, and pass/fail/skipped mapping with **unrecognized conclusions falling to pending, not fail**.
- [x] 1.3 Load submitted reviews via `origin pr view <number> --json reviews -R <repo>` during PR detail loading (not `origin api`, which has no reviews endpoint), map them into the shared review metadata, and cover the exact arguments and detail result with focused Rust tests.

## 2. Origin Approval Write

- [x] 2.1 Add pinned bodyless Origin approval arguments, wire `OriginProvider::approve_pr`, and test that no body or review-action argument is accepted or spawned.

## 3. Pull-request Approval Availability

- [x] 3.1 Expose the shared bodyless Approve action for Origin while keeping all text-authoring actions absent.
- [x] 3.2 Add focused `PrConversation` tests for Origin approval dispatch and pending behavior.

## 4. Verification

- [x] 4.1 Run focused Origin Rust tests and the `PrConversation` frontend tests.
- [x] 4.2 Run `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`, and `bun run sizes`.
- [x] 4.3 Run `cargo check`, `cargo fmt --all -- --check`, and `cargo clippy --all-targets --all-features -- -D warnings` from `src-tauri`.
- [x] 4.4 In `bun run tauri dev` against an Origin repository with an open pull request that has at least one CI check run, verify real check states and a bodyless approval refresh correctly without exposing credentials. The CLI is signed in, so this is not blocked — but no existing repository has an open PR or a check run, so create a disposable one.
- [x] 4.5 During 4.4, capture one real `pr checks --json` and one real `pr view --json reviews` payload, confirm the conclusion vocabulary and review-entry shape assumed in `design.md`, and correct the mapping and fixtures if they differ.
