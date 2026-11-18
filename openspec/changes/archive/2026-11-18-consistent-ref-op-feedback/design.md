# Design

## Context

There are two kinds of feedback today.

**Step dialogs.** `delete-branch/`, `delete-worktree/`, `remove-detached/` and `handoff/` share the `useStepRun` scaffold, the `progress/` StepList and the `ModalFrame` with a header close (`DialogCloseRow`). They differ in how they finish:

| Dialog | Success | Failure |
| --- | --- | --- |
| `DeleteBranchDialog` | Ticked list. `setTimeout(close, DONE_CLOSE_MS)`, where `DONE_CLOSE_MS` is 1200. The success `message` is set but never shown. | Message and Close button |
| `DeleteWorktreeDialog` | A "Deleted ‹branch›" screen with the backend message verbatim and no button. Focus goes to the header ✕. | Message and Close button |
| `RemoveDetachedDialog` | A result screen with per-row ✓/✗ and no button. A partial failure also lands here. | n/a (failures are per row) |
| `HandoffDialog` | A "Handed off to …" screen with the message and no button | Message and Close button |

Both delete commands can succeed with a caveat. In Rust, `deleted_branch_config_warning` appends `", but its local branch settings could not be removed: …"` to `Deleted ‹branch›…`. This happens in `git/write/branches/delete.rs` and `git/write/worktrees/lifecycle.rs`.

**Pending pill.** `checkoutPending: Record<repoKey, PendingCheckoutRef>` lives in the repo store. It is set and cleared in `repoWriteActions/checkoutFeedback.ts` and read by `useCheckoutPending` in `RefPill` and `CombinedRefPill`, which render `InlineSpinner` and `aria-busy`. The record holds one ref per repository and also backs `CheckoutBusyError`. Other ref writes go through `useBranchOp`/`run(…)`. That helper toasts errors and shows nothing while the write runs.

## Goals / Non-Goals

**Goals:** one pending indicator for ref writes, set where the write runs, and one ending for step dialogs. See the proposal for the scope.

**Non-Goals:**
- Merging `refWritesPending` into `checkoutPending`.
- Any Rust change.
- Changing the confirm-dialog flow.
- Navigator rows.

## Decisions

### A separate `refWritesPending` record, not `checkoutPending`

`RepoState` gains `refWritesPending: Readonly<Record<string, readonly PendingRefWrite[]>>`. It is keyed by `checkoutKey(path)`, and each entry is `{ id: number; refs: RefLabelKey[] }`, where `RefLabelKey = { name: string; kind: "local" | "remote" | "tag" }`.

- A write can touch two pills (local and `origin/x`), and two writes can overlap, for example a push of `a` and a delete of `b`. So the value is a list of entries, and one entry is removed by its `id`.
- Reusing `checkoutPending` would make `CheckoutBusyError` refuse checkouts during a push. The spec forbids that.
- *Alternative:* a ui-store set. Rejected, because pending state must be per repository and must survive tab switches the same way `checkoutPending` does.

The field joins the carried-across-switch list in `repoTypes/data.ts` (`"fetchingPath" | "checkoutPending" | …`, around line 278) and gets its initial `{}`.

### One wrapper in the store, applied in the actions

Add `withRefWrite(set, get, repoPath, refs, op)` beside the checkout helpers. One option is a new `repoWriteActions/refWritePending.ts`, since `checkoutFeedback.ts` is 173 lines. The wrapper works like this:

1. Push an entry.
2. `await op()`.
3. In a `finally`, remove the entry by `id`.

It does not swallow errors. The menu's `run` still toasts them.

Wrap these store actions, so every entry point gets the indicator:

| File | Action | Refs |
| --- | --- | --- |
| `branches.ts` | `removeBranch` | local |
| `branches.ts` | `deleteBranchAndRemote` | local, `remote/branch` |
| `branches.ts` | `deleteBranchWithWorktree` | local |
| `branches.ts` | `renameBranchTo` | old local name |
| `remotes.ts` | `deleteRemoteBranch` | `remote/branch` |
| `remotes.ts` | `pushBranch`, `publishBranch`, `forcePush` | local |
| `tags.ts` | `deleteTag` | tag |
| `tags.ts` | `pushTag` | tag |

The toolbar's `push`/`pull` are not wrapped (proposal non-goal).

The key is the path the action already acts on. `removeBranch`, `deleteBranchAndRemote` and `deleteBranchWithWorktree` take an explicit `repoPath`. `runOp` actions use `summary.path`, captured inside the op. The entry stays until the action's own refresh has run. The pill for a deleted ref then disappears together with its spinner instead of flashing back to its icon first.

### Pill reads both records

`useCheckoutPending(labels)` becomes `useRefPending(labels)`, a rename in `commit-row/`. It returns true when `checkoutPending` matches (existing `pendingMatchesLabel`) **or** any `refWritesPending[key]` entry has a ref matching a label. A ref matches when the names are equal and the kinds agree: `RefKind.Branch` with `local`, `RefKind.Remote` with `remote`, `RefKind.Tag` with `tag`. It still selects a boolean, so only the affected pill re-renders. `RefPill` and `CombinedRefPill` need no other change.

### Step dialogs end the same way

- Hoist `DONE_CLOSE_MS` and the auto-close effect into a small shared hook. A good home is `useCloseWhenDone(phase, close)` in `overlays/progress/`, next to `StepList`. `DeleteBranchDialog` and `DeleteWorktreeDialog` use it, and so does `RemoveDetachedDialog` when no row failed.
- `DeleteWorktreeDialog`: delete the `phase === "done"` screen. Show the StepList while `phase` is `running` or `done`, with every row done on `done`, as `DeleteBranchDialog` already does. The focus-on-done effect becomes the shared hook's.
- **Caveat notification.** When a delete succeeds, its run hook compares the message with the routine text it expects: `Deleted ${branch}` or `Deleted ${branch} and ${remote}/${branch}` for the branch dialog, and `Deleted ${branch} and its worktree` for the worktree dialog. If they differ, it calls `showToast(message, "warning")`. The text is the backend's own, so the user sees exactly what git reported. The check runs whether or not the dialog is still mounted. A closed dialog's routine success stays silent, as today.
  - `deleteBranchAndRemote` (`branches.ts:118`) returns a fixed `Deleted ${name} and ${remoteRef}` and drops the local delete's caveat. It must keep whatever the backend message adds after `Deleted ${name}` and append that suffix to its own text.
  - *Alternative:* a structured `warning` field from Rust. That is cleaner, but it needs a four-layer IPC change for one string. Rejected, and recorded as a `shortcut:` comment at the comparison.
- `RemoveDetachedDialog`: with no failed row, auto-close. With a failed row, keep the screen and add a `LARGE_SECONDARY_BUTTON` "Close" with `autoFocus`.
- `HandoffDialog`: keep the done screen and add the same Close button.

### Store and size

- Only the `repo` store changes, by one field. No new store.
- File sizes:
  - `remotes.ts` (322 lines) sits in the look band. Wrapping three actions adds a few lines, so it must be checked with `bun run sizes`. If it crosses, `withRefWrite` stays in its own file and the call sites stay one-liners.
  - The dialogs shrink or grow by under 15 lines.

## Risks / Trade-offs

- [The caveat check compares strings and breaks if the Rust success wording changes] → A unit test in each run hook pins the routine text. The Rust tests already pin `Deleted {branch}…`. The `shortcut:` comment names the IPC upgrade.
- [A spinner on a ref whose write is fast, such as a local delete or rename, flashes for one frame] → Acceptable. Checkout behaves the same way.
- [An entry leaks if an action throws before `finally`] → The wrapper's `finally` covers every path. The store test asserts the record is empty after both success and failure.
- [Remote-ref pill for `deleteRemoteBranch`] → The ref is `${remote}/${branch}`, and that is what the remote pill's `RefLabel.name` holds. `CombinedRefPill` passes both labels.
