# Tasks

## 1. Confirm dialog checkbox

- [x] 1.1 In `src/store/ui/dialogs.ts`, add an optional `option?: { label; warning?; confirmLabelWhenChecked? }` field to `ConfirmRequest`, and widen `onConfirm` to `(optionChecked: boolean) => void`.
- [x] 1.2 In `src/components/chrome/overlays/dialogs/ConfirmDialog.tsx`:
  - Render a labelled checkbox when `option` is set. Keep its state in local `useState(false)`.
  - While it is ticked, show `warning` in the warnings style and swap the confirm label.
  - Pass `checked` to `onConfirm`.
- [x] 1.3 In `src/components/chrome/overlays/menus/previewConfirm.ts`, accept `option` and pass it through. Change `onConfirm` to `(preview, optionChecked)`.

## 2. Menu policy

- [x] 2.1 In `branchContextMenuPolicy.ts`, add `upstreamDeleteTarget: { remote; branch; oid } | null`:
  - Hoist the existing `upstreamRemote` and `localUpstreamBranch` and derive the target from them.
  - Set it only when `localDeleteMode === "branch"`, the remote is not `.`, and a `BranchKind.Remote` ref named `${remote}/${branch}` exists.
  - Take `oid` from that ref's `target`.
- [x] 2.2 Pass the field through `branch-context-menu/context.ts` and `BranchContextMenu.tsx`.

## 3. Store action

- [x] 3.1 Add `deleteBranchAndRemote(name, localOid, target, repoPath)` to `src/store/repoTypes/writeActions.ts`.
- [x] 3.2 Implement it next to `removeBranch` in `src/store/repoWriteActions/branches.ts`. If `authFor`/`trackNet` can only be reached from `remotes.ts` without a cycle, implement it there instead. The action:
  - Deletes the remote branch first, on the captured `repoPath`. On failure, it rethrows saying "nothing was deleted".
  - Re-checks that the repo is still the active one, then force-deletes the local branch. On failure, it rethrows naming the deleted remote ref and the local branch that was kept.
  - Calls `refreshIfCurrent` and returns `Deleted <name> and <remote>/<branch>`.

## 4. Wire the existing delete row

- [x] 4.1 In `branch-context-menu/destructiveActions.tsx`, change the `Delete <b>` row's `previewConfirm`:
  - When `upstreamDeleteTarget` is set, pass `option`:
    - label: `Also delete <remote>/<branch> on the remote`
    - warning: the existing remote-delete wording
    - confirm label when ticked: `Delete both`
  - In `onConfirm`, call `deleteBranchAndRemote` when the box is ticked, and `removeBranch` otherwise.
  - Add no new menu row.

## 5. Tests

- [x] 5.1 Add a `ConfirmDialog` test (`src/components/chrome/overlays/dialogs.test.tsx`) covering:
  - A request without `option` shows no checkbox, and `onConfirm` receives `false`.
  - With `option`, the checkbox starts unticked.
  - Ticking it shows the warning and the swapped label, and `onConfirm` receives `true`.
- [x] 5.2 Add cases to `branchContextMenuPolicy.test.ts`:
  - A live upstream sets the target, with `oid` taken from the remote ref rather than the local tip.
  - The target is null when there is no upstream, the upstream remote is `.`, the tracking ref is missing, the branch is current, or the branch is held by a worktree.
- [x] 5.3 Add store tests for `deleteBranchAndRemote`, with IPC mocked using the `vi.hoisted` + `vi.mock` pattern:
  - Both deletes succeed, in order: remote, then local.
  - The remote delete fails: `delete_branch` is never invoked, and the message says nothing was deleted.
  - The remote delete succeeds and the local delete fails: the message names both outcomes.
  - The active repo changes before the local step: the local delete is refused.
- [x] 5.4 Add a menu test showing that the delete confirmation for a branch with a live upstream carries the option, and that one without an upstream does not.

## 6. Checks

- [x] 6.1 Run `bun check`.
- [x] 6.2 Run `bun run test`.
- [x] 6.3 Run `bun run build`.
- [x] 6.4 Run `bun run sizes`, `bun run cycles`, and `bun run coverage`.
- [x] 6.5 Manual check in `bun run tauri dev`:
  - Delete a merged branch that has a live `origin/<branch>` with the box ticked. Both refs should disappear and the remote should no longer have the branch.
  - Delete another such branch with the box unticked. Only the local branch should be removed.

## 7. Review fixes

- [x] 7.1 Restrict `upstreamDeleteTarget` to a same-named upstream, and add a policy test for `feature` tracking `origin/main`.
- [x] 7.2 Add `StepOutcomeError` in `src/lib/gitError.ts`, render it in `showToast` above the failure's own copy and actions, and test this for index-lock and auth failures.
- [x] 7.3 Run the local step through `removeBranch`.
- [x] 7.4 Preview the remote ref in the delete row, feed it into the checkbox warnings, and let `previewConfirm` take `option` as a function of the preview.
- [x] 7.5 Show a progress toast for the combined delete, and test that it is dismissed.
- [x] 7.6 Put the ticked warnings in an `aria-live` region linked to the checkbox with `aria-describedby`.

## 8. Delete-branch dialog

- [x] 8.1 Add the `deleteBranch` / `deleteBranchRunning` slot and its actions to `src/store/ui/dialogs.ts`, and include them in the repo-switch reset and the open-dialog check.
- [x] 8.2 Add the `onDeleted` callback to `removeBranch` and the `onStep` callback to `deleteBranchAndRemote`, and drop the progress toast.
- [x] 8.3 Add `friendlyStepError` to `src/lib/gitError.ts` and use it from `showToast` and the dialog.
- [x] 8.4 Add `DeleteBranchDialog` and `useDeleteBranchRun` under `overlays/delete-branch/`, and register the dialog in `AppOverlays`.
- [x] 8.5 Make the Danger zone delete row open the dialog, and revert the `ConfirmDialog` / `previewConfirm` checkbox.
- [x] 8.6 Add dialog tests (plain run, ticked run with partial failure, remote failure, remote preview failure, local preview failure, closed mid-run), and update the menu and store tests.
