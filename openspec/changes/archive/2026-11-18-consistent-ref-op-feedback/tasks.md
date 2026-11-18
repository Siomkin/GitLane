# Tasks

## 1. Pending ref writes in the repo store

- [x] 1.1 Add `refWritesPending` (type `PendingRefWrite { id; refs: { name; kind: "local" | "remote" | "tag" }[] }`) to `RepoState` in `src/store/repoTypes/data.ts`. Initialise it to `{}` and add it to the carried-across-switch list next to `checkoutPending`. Verify with `bun check`.
- [x] 1.2 Add `withRefWrite(set, get, repoPath, refs, op)` in `src/store/repoWriteActions/refWritePending.ts`. It pushes an entry keyed by `checkoutKey(repoPath)`, awaits `op`, and removes the entry by `id` in `finally`. It rethrows errors. Verify with a store test in `refWritePending.test.ts` covering success, failure, two overlapping writes in one repo, and the record being empty afterwards.
- [x] 1.3 Wrap `removeBranch`, `deleteBranchAndRemote`, `deleteBranchWithWorktree` and `renameBranchTo` in `branches.ts`. Verify with store tests asserting the entry exists while the mocked `invoke` is pending and is gone after the refresh.
- [x] 1.4 Wrap `deleteRemoteBranch` (ref `remote/branch`), `pushBranch`, `publishBranch` and `forcePush` in `remotes.ts`. Verify with store tests as in 1.3. Run `bun run sizes`, because `remotes.ts` is at 322 lines.
- [x] 1.5 Wrap `deleteTag` and `pushTag` in `tags.ts` (kind `tag`). Verify with store tests as in 1.3.
- [x] 1.6 Add a store test that a running `pushBranch` does not make `checkoutBranch` throw `CheckoutBusyError`.

## 2. Pill indicator

- [x] 2.1 Rename `useCheckoutPending` to `useRefPending` in `src/features/graph/commit-row/`. It returns true for a `checkoutPending` match or for any `refWritesPending[key]` ref whose name and kind match a label (Branch with local, Remote with remote, Tag with tag). Update `RefPill` and `CombinedRefPill`. Verify with `RefPill.test.tsx` cases:
  - a remote pill spins during `deleteRemoteBranch`;
  - a combined pill spins when either ref is written;
  - a tag pill spins during `deleteTag`;
  - no spinner shows in another repository's key.

## 3. Step dialogs end the same way

- [x] 3.1 Move `DONE_CLOSE_MS` and the focus-then-close effect out of `DeleteBranchDialog.tsx` into `useCloseWhenDone(phase, close)` under `src/components/chrome/overlays/progress/`. Use it from `DeleteBranchDialog`, and verify that the existing `DeleteBranchDialog.test.tsx` passes unchanged.
- [x] 3.2 In `DeleteWorktreeDialog.tsx`, remove the `phase === "done"` screen. Keep the StepList for `running` and `done`, with all rows done on `done`, and call `useCloseWhenDone`. Update `DeleteWorktreeDialog.test.tsx` so that success ticks the rows and closes after `DONE_CLOSE_MS` with fake timers, and no "Deleted …" heading renders.
- [x] 3.3 Change `deleteBranchAndRemote` to keep the local delete's caveat by appending whatever the backend message adds after `Deleted ${name}` to its own text. Verify with a store test using a mocked caveat message.
- [x] 3.4 In `useDeleteBranchRun` and `useDeleteWorktreeRun`, when a success message differs from the routine text, call `showToast(message, "warning")`. This applies whether or not the dialog is mounted. Add a `shortcut:` comment that names the structured-warning IPC upgrade. Verify with tests for both a caveat message (a warning toast appears) and a routine message (no toast appears).
- [x] 3.5 In `RemoveDetachedDialog`, auto-close via `useCloseWhenDone` when no row failed. When a row failed, keep the result screen and add a "Close" `LARGE_SECONDARY_BUTTON` with `autoFocus`. Verify with `RemoveDetachedDialog.test.tsx` cases for all-success and partial-failure.
- [x] 3.6 In `HandoffDialog`, add the same Close button to the done screen. Verify with a case in `HandoffDialog.test.tsx` showing the button closes the dialog.

## 4. Verification

- [x] 4.1 Run `bun check`, `bun run test`, `bun run build`, `bun run sizes`, `bun run cycles` and `bun run coverage`. All must pass, and the coverage ratchet must not drop.
- [x] 4.2 Manual check in `bun run tauri dev`:
  - "Delete X on remote" shows a spinner on the `origin/X` pill until it is gone;
  - deleting a branch with its worktree closes the dialog by itself;
  - pushing a branch from its menu spins its pill;
  - a double-click checkout still works during that push.
