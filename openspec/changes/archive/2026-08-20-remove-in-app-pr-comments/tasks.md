## 1. Align Concurrent Planning

- [x] 1.1 Reconcile `complete-origin-pr-collaboration` by removing its top-level comment and review-body requirements, design decisions, and tasks while preserving unrelated checks, submitted-review reads, and bodyless approval scope.

## 2. Make PR Discussion Read-Only

- [x] 2.1 Remove the comment/review textarea and text-submitting actions from `PrConversation`, retain bodyless approval for supported open PRs, and add the explicit provider handoff using the existing PR URL, opener, forge label, and error feedback.
- [x] 2.2 Remove the reply form and reply pending state from `ReviewThreadControls` while preserving resolve/reopen behavior and existing discussion rendering.
- [x] 2.3 Add focused component tests proving comments and replies remain visible without text editors, approval submits no body, the provider action opens the exact supplied PR URL, and missing/invalid URLs surface errors.

## 3. Narrow Frontend State and IPC API

- [x] 3.1 Remove `commentPr`, `replyThread`, their pending-action keys, and obsolete review-action types from the pulls store contract and implementation; replace generic review submission with an approval-only action and keep its detail/check refresh behavior.
- [x] 3.2 Remove comment/reply invoke wrappers from `src/lib/api/github.ts` and replace the generic review wrapper with an approval-only signature that sends no action or body.
- [x] 3.3 Update pulls store and invoke-mock tests to cover approval, thread resolution, and refresh ownership without any removed comment/reply command.

## 4. Delete Provider Comment Writes

- [x] 4.1 Remove comment and thread-reply methods from the forge provider contract and implementations, including GitHub GraphQL/CLI helpers and Origin comment execution.
- [x] 4.2 Replace generic provider review methods with bodyless approval in GitHub, GitLab, Bitbucket, and Origin, deleting request-changes, comment-only, and optional-body argument branches.
- [x] 4.3 Update provider unit tests to pin approval-only commands and prove no comment text or body argument is accepted or spawned.

## 5. Keep the IPC Contract in Sync

- [x] 5.1 Remove `comment_pull_request` and `reply_review_thread`, replace `review_pull_request` with an approval-only Tauri command, and update the `generate_handler!` registration in `src-tauri/src/lib.rs`.
- [x] 5.2 Update command registration tests and exact searches so no frontend wrapper, store action, Rust command, handler entry, provider method, or mutation helper for PR comments/replies remains.

## 6. Verify

- [x] 6.1 Run `bun run test`, `bunx tsc --noEmit`, `bun run lint`, `bun run build`, and `bun run sizes`.
- [x] 6.2 Run `(cd src-tauri && cargo check)`, `(cd src-tauri && cargo fmt --all -- --check)`, and `(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings)`.
- [x] 6.3 In `bun run tauri dev`, verify a PR with comments and review threads is read-only, bodyless approval and resolve/reopen still refresh, and the provider handoff opens the exact PR page with visible failure feedback for an unavailable URL.
