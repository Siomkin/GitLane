# Proposal

## Why

Branch operations give inconsistent feedback. The branch delete dialog shows its step list and then closes itself. The "Delete ‹branch› & worktree" dialog shows the same steps and then switches to a "Deleted ‹branch›" screen. That screen has no button, so the only way out is the header ✕ or Escape. Meanwhile, ref writes started from a menu show nothing while they run. "Delete ‹branch› on remote", tag deletes, renames and pushes are examples. The pill the user acted on stays unchanged until the graph refreshes. Double-clicking a ref to check it out already shows a spinner on that pill. These other writes should do the same.

Jira: none yet.

## What Changes

- **The worktree delete dialog closes itself on success.** It works like the branch delete dialog: the ticked step list stays briefly, then the dialog closes. The "Deleted ‹branch›" done screen is removed.
- **A success that carries a caveat is not lost.** A delete can succeed and still report a caveat, such as ", but its local branch settings could not be removed: …". When the dialog closes itself, that text appears as a warning notification. This covers both delete dialogs. Today the branch dialog drops the caveat without showing it.
- **The detached-worktree remove dialog** closes itself after a clean run. It also follows the routine-success rule. A run with a partial failure keeps its result screen and gains a Close button.
- **The hand-off dialog's** done screen stays, because its message describes where the work went, for example a kept stash. It gains a Close button so no done screen is left without one.
- **A ref being written shows that it is pending.** From the request until the write finishes or fails, the graph pill of each ref the write acts on shows a spinner and is marked busy. This is the same indicator the checkout uses. It covers:
  - deleting a local branch, with or without its remote counterpart or worktree;
  - deleting a branch on the remote;
  - renaming a branch;
  - pushing, publishing and force-pushing a branch;
  - deleting a tag, locally or also on the remote;
  - pushing a tag.

  The spinner shows whichever way the write was started, from a menu or from a dialog. The toolbar Push and Pull keep their own button state and are not changed.
- A pending ref write does not refuse or block a checkout. Only the existing checkout busy guard refuses a checkout.

Process: frontend only. No Rust, no IPC, no new command.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `history/write-ops`: adds requirements for pending pills during ref writes and for how delete and remove dialogs finish. The existing "The ref being checked out shows that it is pending" requirement is unchanged.

## Non-goals

- No spinner on branch navigator rows. Today the navigator shows none for checkout either. It is a transient dropdown that closes when a row's menu acts.
- No change to the confirm dialogs themselves. "Delete on remote" and the tag deletes keep their one-step confirm, and their progress shows on the pill.
- No progress card or toast for ref writes. The pill spinner is the whole indicator, and routine success stays silent, as today.
- No change to the GitHub sign-in dialog. Its done screen already has buttons.
- No new step dialog for operations that do not have one.

## Dependencies

`delete-local-and-remote-branch` has merged but is not archived. Its dialog requirements, including "The delete dialog shows each step until the delete finishes", are therefore not in the main spec yet. This change only adds requirements, so the two changes can be archived in either order.

## Risks

- No secrets, auth or IPC surface is touched. The push-family writes keep their existing transport-auth path. Only a pending marker is added around them.

## Impact

- `src/components/chrome/overlays/delete-worktree/` changes the done phase in the dialog and the run hook. `delete-branch/` gets the caveat notification. `remove-detached/` and `handoff/` change their done screens.
- `src/store/repoTypes/data.ts` adds a per-repository pending-refs record, carried across repo switches like `checkoutPending`.
- `src/store/repoWriteActions/` wraps the listed store actions in that record. The affected files are `branches.ts`, `remotes.ts` and the tag actions.
- `src/features/graph/commit-row/` updates `RefPill`, `CombinedRefPill` and `useCheckoutPending`. The latter is renamed or widened.
- Patterns to copy: `checkoutPending`, with `src/lib/checkoutPending.ts` and `useCheckoutPending.ts` for the pill, and `DeleteBranchDialog`'s `DONE_CLOSE_MS` auto-close for the dialogs.
