# Tasks

## 1. Rust: quiet switch and redacted output

- [x] 1.1 Add `-q` to `switch_branch` and `switch_detached` in `src-tauri/src/git/write/head.rs`, and to the `switch --track -c` create path in `branch_checkout.rs`. Verify that `cargo test branch_checkout` and the `handoff_move` tests still pass.
- [x] 1.2 In `branch_checkout.rs`, return `crate::redact::redact_secrets(&output)` from `checkout` and from every success path of `checkout_remote_branch`. Return the switch output, or the merge output on the current-branch path (D3). Verify with a test whose `post-checkout` hook echoes a token-shaped string: the returned string is redacted, and with no hook it is empty.

## 2. Rust: move the ref first, then switch once

- [x] 2.1 Restructure `checkout_remote_branch` per design D1:
  - classify first into up-to-date / fast-forward / equivalent sibling, carrying the classified oids as compare-and-swap preconditions;
  - for the current branch, update in place without a switch (`fast_forward_branch_at_locked`, quiet merge);
  - refuse a branch any worktree holds before anything moves: checked out (prunable included), or claimed by a rebase or bisect (`worktrees::branch_claim`, shared with the direct fast-forward);
  - otherwise move the ref with one `update-ref --stdin` transaction that verifies the remote ref and writes a reflog message (`move_local_ref`), reclassifying once if a fetch moved the remote, then make one `switch_branch`.

  Verify with `cargo test branch_checkout`.
- [x] 2.2 Following `tests/commits/squash_hooks.rs`, add hook-count tests in `tests/branch_checkout/` (new `hooks.rs`, registered in `tests/branch_checkout.rs`). Install `post-checkout` and `post-merge` hooks that append to a log file, then assert:
  - local behind: one `post-checkout` with the remote oid as new HEAD, no `post-merge`;
  - local equal or ahead: one `post-checkout`;
  - current branch behind: one `post-merge`, no `post-checkout`;
  - current branch equal: no hooks.
- [x] 2.3 Rewrite `checkout_remote_branch_reports_switch_when_dirty_changes_block_fast_forward` in `tests/branch_checkout/refuses.rs` for D2: it errors, HEAD is unchanged, the dirty file is intact, and the local ref is advanced to the remote tip. Verify the test passes.
- [x] 2.4 Add a test that a remote-branch checkout run from the main worktree, while a linked worktree holds the branch, fails with no ref, index, or file changes in either worktree. Verify the test passes.
- [x] 2.5 Confirm the existing `equivalent.rs`, `tracking.rs`, and `refuses.rs` cases (equivalent sibling, dirty-state-preserving alignment, stale-oid CAS, diverged refusal, in-progress-operation refusal) still pass unchanged with `cargo test branch_checkout`.

## 3. Frontend: checkout feedback in the store

- [x] 3.1 Add the `withCheckoutFeedback(label, run)` helper (design D4) to `src/store/repoWriteActions/checkout.ts`; use `checkoutFeedback.ts` instead if `checkout.ts` would exceed 200 lines. It shows a 400 ms-delayed `progress` card through `useNotifications`, dismisses it in `finally`, and posts an `info` "Checked out <label>" card for 15 s when the output is non-empty: the first 8 and last 30 lines with the middle elided, "Updating/Updated" for a branch advanced in another worktree, and the repository's name once it is no longer the open one. Verify with `bunx tsc --noEmit`.
- [x] 3.2 Route `checkoutBranch`, `checkoutRemoteBranch`, and `checkoutDetached` (the inner `api.checkout` call in `runOp`) through the helper. Leave the worktree-dialog and open-worktree branches unwrapped. Verify that `bun run test` passes for the existing menu, RefPill, and loadRepo tests.
- [x] 3.3 Add `src/store/repoWriteActions/checkout.test.ts`, mocking `invoke` inline per `src/test/README.md` and using fake timers. Assert that:
  - a call resolving after 1 s shows then dismisses a progress card titled "Checking out develop…";
  - a call resolving in 100 ms shows no card;
  - non-empty output posts an info card containing it;
  - empty output posts none;
  - a rejected call dismisses the card and rethrows.
- [x] 3.4 Update the doc comments on `checkout` / `checkoutRemoteBranch` in `src/lib/api/git/branches.ts` to say the returned string is redacted hook/warning output (empty when there is none). Verify with `bunx tsc --noEmit`.

## 4. Integration checks

- [x] 4.1 Run the Rust gates and confirm each exits 0: `(cd src-tauri && cargo fmt --all -- --check)`, `cargo clippy --all-targets --all-features -- -D warnings`, and `cargo test`.
- [x] 4.2 Run the frontend gates and confirm each exits 0: `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes`, and `bun run cycles`.
- [x] 4.3 In `bun run tauri dev`, open the GoldX repo with `develop` behind `origin/develop` and double-click the `origin/develop` pill. Verify that:
  - the "Checking out develop…" card appears;
  - `[php-switch]` runs once, not twice;
  - the hook output shows in the "Checked out develop" card;
  - `develop` is at the `origin/develop` commit.

## Workflow follow-up

- Archive the change after review, merging the delta into `openspec/specs/history/write-ops/spec.md`.
