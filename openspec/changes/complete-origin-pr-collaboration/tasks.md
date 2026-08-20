## 1. Origin Checks and Review Data

- [ ] 1.1 Add focused Origin DTO child modules for check results and submitted reviews, deserializing permissively (unknown enum values must not fail the payload), with status, verdict, and dismissal normalization tests over camelCase fixtures.
- [ ] 1.2 Add the pinned `origin pr checks <number> --json name,status,conclusion -R <repo>` operation, wire `OriginProvider::pr_checks`, and test exact arguments, the `group / name` label when `group` is present, the empty-`[]` case, and pass/fail/skipped mapping with **unrecognized conclusions falling to pending, not fail**.
- [ ] 1.3 Load submitted reviews via `origin pr view <number> --json reviews -R <repo>` during PR detail loading (not `origin api`, which has no reviews endpoint), map them into the shared review metadata, and cover the exact arguments and detail result with focused Rust tests.

## 2. Origin Collaboration Writes

- [ ] 2.1 Add pinned Origin top-level comment arguments and execution with an empty-body guard, passing the body through `-F -` on stdin rather than `-b <body>`, wire `OriginProvider::comment_pr`, and cover successful arguments, the stdin body, and rejected input.
- [ ] 2.2 Add pinned Origin approval arguments and execution with optional stdin body text, wire `OriginProvider::review_pr`, and test that request-changes (CLI-unsupported), formal comment-only reviews (deferred by GitLane, with a distinct message), and unknown actions all fail before spawning Origin.

## 3. Pull-request Composer Availability

- [ ] 3.1 Replace the Origin-wide composer hide with the minimal provider gates that expose Comment and Approve while keeping Request changes absent.
- [ ] 3.2 Add focused `PrConversation` tests for Origin comment/approval dispatch, pending behavior, and request-changes absence while preserving GitHub behavior.

## 4. Verification

- [ ] 4.1 Run focused Origin Rust tests and the `PrConversation` frontend tests.
- [ ] 4.2 Run `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`, and `bun run sizes`.
- [ ] 4.3 Run `cargo check`, `cargo fmt --all -- --check`, and `cargo clippy --all-targets --all-features -- -D warnings` from `src-tauri`.
- [ ] 4.4 In `bun run tauri dev` against an Origin repository with an open pull request that has at least one CI check run, verify real check states, a top-level comment, and an approval refresh correctly without exposing credentials. The CLI is signed in, so this is not blocked — but no existing repository has an open PR or a check run, so create a disposable one.
- [ ] 4.5 During 4.4, capture one real `pr checks --json` and one real `pr view --json reviews` payload, confirm the conclusion vocabulary and review-entry shape assumed in `design.md`, and correct the mapping and fixtures if they differ.
