# Design

## Context

Today a branch can be deleted in two separate ways.

- **Local delete.** The `Delete <branch>` row in `branch-context-menu/destructiveActions.tsx`
  calls `previewConfirm` with `api.previewDeleteBranch`, then calls the store's
  `removeBranch(name, expectedOid, repoPath, force = true)`. `removeBranch` takes the
  repository path explicitly. It refuses if the active repository has changed.
- **Remote delete.** The `Delete <branch> on remote` row appears only on a
  remote-tracking row. `deriveBranchContextMenuPolicy` sets `remoteDeleteTarget` only
  when `isRemote` is true. The row calls `deleteRemoteBranch(remote, branch, tip)`
  through `runOp`, which reads the live `summary.path`.

`ConfirmDialog` renders a `ConfirmRequest` with these fields: title, message, facts,
details, warnings, an optional `secondary` button, and `onConfirm: () => void`. It has
no form controls.

Both deletes shell out to `git` under `git/write/`: `git branch -D` and
`git push <remote> --delete`. If the remote branch is already gone, the remote delete
still counts as success and prunes the tracking ref.

## Goals / Non-Goals

**Goals**

- The delete popup offers the remote counterpart as an opt-in checkbox.
- The two deletes run in a safe order.
- A partial failure produces an honest message.
- The confirmed repository is never retargeted.

**Non-Goals**

See the proposal. There is no new menu row, no change to the GL-107 worktree dialog, and
no Rust change.

## Decisions

### UI: a checkbox inside the existing delete popup

The user preferred to keep everything in the popup and asked for no extra menu row.

`ConfirmRequest` gains:

```ts
/** One opt-in checkbox shown above the buttons. Starts unticked. */
option?: {
  label: string;               // "Also delete origin/feature on the remote"
  warning?: string;            // shown only while ticked
  confirmLabelWhenChecked?: string; // e.g. "Delete both"
};
onConfirm: (optionChecked: boolean) => void;
```

Existing callers ignore the argument, so they need no change.

`ConfirmDialog` changes:

- It keeps `checked` in local `useState(false)`. The state lives in the dialog, not in
  the ui store, so it resets every time the dialog opens.
- It renders a labelled native checkbox, reachable by keyboard.
- While the box is ticked, it shows `warning` in the warnings style and swaps the
  confirm label.

`previewConfirm` gains an `option` parameter and passes it through. Its `onConfirm`
becomes `(preview, optionChecked)`.

*Alternative considered:* a separate `Delete <branch> & <remote>/<branch>…` menu row.
It needs no dialog change, but it adds menu noise and the user turned it down.

### Engine: compose the two existing CLI writes

There is no new Rust command and no libgit2 write. With the box ticked, the frontend runs
`api.deleteRemoteBranch` and then `api.deleteBranch`. The four IPC layers and the agent
table are unchanged.

*Alternative considered:* a single Rust command. It would be atomic in name only,
because a push cannot be rolled back, and it would need the full four-layer IPC change.
Rejected.

### Policy: `upstreamDeleteTarget` on local rows

`deriveBranchContextMenuPolicy` gains
`upstreamDeleteTarget: { remote, branch, oid } | null`. It is non-null only when all of
these hold:

- `localDeleteMode === "branch"`. This is the only row that gets the option.
- `upstreamRemote` is set and is not `.`.
- `localUpstreamBranch === branch`. A differently-named upstream (`feature` tracking
  `origin/main`, git's default after `checkout -b feature origin/main`) is a shared
  branch, never this branch's counterpart.
- `branches` contains a `BranchKind.Remote` entry named
  `${upstreamRemote}/${localUpstreamBranch}`. That entry's `target` becomes `oid`,
  which is the lease.

`upstreamRemote` and `localUpstreamBranch` are already computed for the forge link, so
the code hoists them instead of recomputing them.

### Order: remote first, then local

- If the remote delete fails (auth, network, or a stale lease), nothing has changed. The
  user can reopen the dialog and retry.
- If the local delete then fails, for example because the branch moved since the
  preview, the remote branch is gone and the local branch remains. That state is
  visible, and an unticked delete finishes the job.
- The local delete stays forced (`force = true`, as today). Deleting the upstream first
  therefore cannot trip the merged check.

### Store action: `deleteBranchAndRemote(name, localOid, target, repoPath)`

This lives next to `removeBranch` in `store/repoWriteActions/branches.ts`. It does the
following, in order:

1. Refuse if `get().summary?.path !== repoPath`.
2. Run `trackNet(…, () => api.deleteRemoteBranch(repoPath, target.remote,
   target.branch, target.oid, authFor(target.remote)))` on the captured `repoPath`. It
   does not go through `runOp`.
   - If `authFor` and `trackNet` are only reachable in `remotes.ts`, put the action
     there instead. `bun run cycles` decides.
   - If this throws, rethrow with a message that nothing was deleted.
3. Check again that the repository is still active, then call
   `api.deleteBranch(repoPath, name, localOid, true)`. If this throws, the message
   names `<remote>/<branch>` as deleted, `<name>` as kept, and the reason.
4. Call `refreshIfCurrent`, then return `Deleted <name> and <remote>/<branch>`.

The menu's `run(…)` already turns the returned string or a thrown error into a toast.

### Wiring in the menu row

The existing `Delete <b>` row's `previewConfirm` gets
`option: upstreamDeleteTarget ? {…} : undefined`. Its `onConfirm` becomes
`(impact, alsoRemote) => alsoRemote && target ? deleteBranchAndRemote(…) : removeBranch(…)`.

## Risks / Trade-offs

- **Not atomic.** The push and the local ref delete cannot share a transaction. This is
  mitigated by the remote-first order and a precise partial-failure message.
- **Snapshot lease.** The remote oid comes from the snapshot taken when the menu opens.
  If a fetch moves `origin/<branch>` before the user confirms, the lease fails closed
  and nothing is deleted.
- **Shared dialog change.** `option` is optional and the `onConfirm` argument is
  ignored by existing callers, so their behaviour does not change. A render test covers
  the unticked default.
- **File sizes.** These files are all well under the ceiling, so no split is due:

  | File | Lines |
  | --- | --- |
  | `ConfirmDialog.tsx` | 199 |
  | `previewConfirm.ts` | 120 |
  | `destructiveActions.tsx` | 103 |
  | `branchContextMenuPolicy.ts` | 187 |
  | `branches.ts` | 121 |

- **Stores.** `useRepo` gains the composed action. The `useUi` dialog type gains only
  the optional field, so no new store concern is added.
- **Dependencies.** No new plugin or JS dependency is needed.

## Revisions after review

- **Same-named upstream only.** See the policy rule above.
- **Partial-outcome messages.** The action throws `StepOutcomeError(outcome, failure)`
  (`src/lib/gitError.ts`). `showToast` renders `outcome` above
  `friendlyGitError(failure, { serverHost })` and attaches the failure's own actions,
  so classified copy (index lock, hooks, auth, SSH) is kept instead of rebuilding the
  error.
- **Local step reuses `removeBranch`.** That keeps one copy of the active-repo guard
  and refresh.
- **Remote preview.** The delete row previews both refs in parallel. The checkbox's
  `warnings` include the remote preview's details and warnings, and a failed remote
  preview withholds only the checkbox. `previewConfirm` accepts `option` as a function
  of the preview.
- **Progress, superseded by the dialog below.** An indeterminate progress toast
  first covered the run. The delete-branch dialog replaced it.
- **Accessibility.** The ticked warnings sit in an `aria-live` region that the
  checkbox references with `aria-describedby`.

## Delete-branch dialog (replaces the confirm and the checkbox in it)

The user asked for progress in place instead of a popup that closes on confirm
(design: `docs/diagrams/delete-branch-and-remote/delete-dialog-states.html`). The
Danger zone `Delete <branch>` row now opens `DeleteBranchDialog`
(`src/components/chrome/overlays/delete-branch/`), which is built like the GL-107
`DeleteWorktreeDialog`.

- **ui store.** `deleteBranch: { branch, repoPath, alsoRemote } | null` plus a
  `deleteBranchRunning` latch, with open, close and set-running actions. A repo
  switch closes the dialog; a run already started keeps its pinned `repoPath`.
- **Configure.** Both previews run in parallel. A failed remote preview withholds only
  the checkbox; a failed local preview disables Delete. The checkbox starts unticked.
  When ticked, the remote preview's lines appear in an `aria-live` region and the
  button reads "Delete both".
- **Run** (`useDeleteBranchRun` on `useStepRun`). Rows are `[Delete <remote>/<b>]`,
  `Delete local <b>`, `Refresh graph`. The store reports progress through callbacks:
  `deleteBranchAndRemote(…, onStep)` emits `"local"` and `"refresh"`, and
  `removeBranch(…, onDeleted)` fires before its refresh. Failures render with
  `friendlyStepError`, the shared helper `showToast` also uses.
- **Outcome.** Success closes itself after `DONE_CLOSE_MS`. A failure marks its row
  and keeps the dialog open. Closed mid-run, a failure toasts and success stays silent.
- **Reverted.** The `ConfirmDialog` / `previewConfirm` checkbox (`option`) is
  reverted, so the shared confirm dialog is back to its original contract.
