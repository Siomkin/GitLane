# Proposal

## Why

Cleaning up after a merged pull request takes two trips through the menus today. The
user deletes the local branch from its own row, then finds the `origin/<name>` row and
deletes it there. The local branch's delete confirmation never offers its remote
counterpart, even when the branch tracks it. The user wants to remove both in one go,
from the popup they already use.

Jira: none.

## What Changes

- The existing `Delete branch <name>?` confirmation gains one checkbox: **Also delete
  `<remote>/<branch>` on the remote**. It shows only when the local branch's upstream is
  a live remote-tracking branch. It is unchecked by default.
- While the box is ticked:
  - the confirm button reads `Delete both`;
  - the dialog states that the remote delete affects everyone using that remote and
    can't be undone here.
- The Danger zone menu is unchanged and gets no new row.
- Confirming with the box ticked deletes the remote branch first, then the local branch:
  - the remote delete is leased to the remote-tracking ref's tip;
  - the local delete is leased to the previewed local tip;
  - both run against the repository the confirmation was opened on.
- One result message reports the outcome, including a partial one (remote deleted,
  local kept) and the reason.
- With the box unticked, the delete behaves exactly as it does today. The separate
  `Delete <branch> on remote` row on `origin/…` rows is unchanged.

Process touched: frontend only.

- **The shared confirm dialog** gains one optional checkbox field. Existing callers do
  not pass it.
- **The menu policy, branch delete row, and a composed store action** are updated.

There is no new IPC command. The change reuses the existing `delete_remote_branch` and
`delete_branch` commands through their wrappers in `src/lib/api/git/remotes.ts` and
`src/lib/api/git/branches.ts`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `history/write-ops` gains new requirements for deleting a local branch together with
  its remote counterpart. The delta lives in `openspec/specs/history/write-ops/spec.md`.

## Non-goals

- No new menu row.
- No change to the `Delete <branch> & worktree…` dialog (GL-107). A branch held by a
  linked worktree keeps today's flow, and its remote is deleted from its own row.
- No remembered checkbox state: it starts unticked every time.
- No bulk or multi-branch delete, and no "delete merged branches" sweep.
- No forge API calls. The remote delete stays a `git push --delete`.
- No new Rust command, DTO, or agent-table entry.

## Impact

- **`src/store/ui/dialogs.ts`**: `ConfirmRequest` gains an optional `option` (a
  checkbox), and `onConfirm` receives whether it was ticked. This follows the pattern
  of the existing optional `secondary` field.
- **`src/components/chrome/overlays/dialogs/ConfirmDialog.tsx`**: renders the checkbox
  and swaps the confirm label while it is ticked.
- **`src/components/chrome/overlays/menus/previewConfirm.ts`**: passes `option` through
  and forwards the ticked state to its `onConfirm`.
- **`src/components/chrome/overlays/menus/branchContextMenuPolicy.ts`**: derives the
  upstream remote target for a local row, the way `remoteDeleteTarget` already does for
  remote rows.
- **`src/components/chrome/overlays/menus/branch-context-menu/destructiveActions.tsx`**:
  the existing `Delete <branch>` row passes the option when a target exists.
- **`src/store/repoWriteActions/branches.ts`**: adds a composed action that takes an
  explicit `repoPath`, modelled on `removeBranch`.
- **Auth and secrets:** the remote delete resolves credentials through
  `authFor(remote)`, exactly like today's remote delete. No secret crosses IPC and
  nothing new is stored.
- **Repositories opened over SSH** keep working, because both commands are already
  remote-capable.
