## Context

See proposal.md for why. Specs: `history/write-ops`.

Today `buildGraphActionSpecs` treats a remote drag source as unmovable, so dropping `origin/feature` on `develop` only offers **rebase-target** (`Rebase develop onto origin/feature`). `git rebase` already takes both operands (`rebase_onto` → `git rebase <onto> <source>`). Local counterpart checkout already exists (`checkout_remote_branch` + `remoteTrackingCheckoutCandidate`). Force-with-lease already exists (`preview_force_push` / `force_push`) but the action bar disables Push when sync is `diverged` and points at the branch danger menu.

Engine: git CLI writes. No new native/JS dependency. Zustand store: `useRepo` (existing `checkoutRemoteBranch`, `rebaseOnto`, `forcePush`). No new store.

## Goals / Non-Goals

**Goals:**

- Flip only the **rebase** operand when a remote-tracking ref is dropped on a **different** local branch: the counterpart local branch moves onto the drop target.
- Keep counterpart-on-counterpart and local-on-remote rebases as they are (local branch moves onto the remote).
- Surface leased force-push beside the existing Push control when the current branch is `diverged`.
- Compose existing commands; no new IPC unless a later task proves checkout+rebase must share one lease.

**Non-Goals:**

- New graph action kinds unless labels/handlers cannot stay honest with `rebase-source` / `rebase-target`.
- Changing merge / fast-forward / reset of a local target onto a remote.
- Auto force-push, `--force` without lease, or publish/set-upstream.
- Branch-menu “Integrate into current” (that copy already means rebase HEAD onto the clicked tip).

## Decisions

### 1. Policy lives in `graphActions.ts`; counterpart name is an input

`buildGraphActionSpecs` stays a pure menu policy. Add an optional `sourceLocalName` (the leaf from `remoteTrackingCheckoutCandidate`). Callers (`ActionMenu`) resolve it with the existing helper and the current branch list.

- Remote source, local target, `sourceLocalName === target.name` (or unresolved): keep today’s feed-target list (`fast-forward-target` / `merge-target` / `rebase-target` / `reset-target`). Unresolved names are the same as counterpart-on-counterpart so we never silently invent a local branch name.
- Remote source, local target, `sourceLocalName !== target.name`: **replace `rebase-target` with `rebase-source`** labeled `Rebase {sourceLocalName} onto {target}`. Merge / FF / reset of the local target stay. Do not offer a second rebase that moves the base.

Alternative considered: a new `rebase-counterpart` kind. Rejected unless `rebase-source` handlers cannot take a resolved local name without misusing `from.name`.

### 2. ActionMenu rebases the local counterpart, not the remote-tracking ref

`git rebase` cannot move `refs/remotes/…`. For `rebase-source` when `from` is remote:

1. Confirm with `source: sourceLocalName`, `onto: to.name`, `needsCheckout: headBranch !== sourceLocalName`.
2. On confirm: if the local counterpart is missing, `checkoutRemoteBranch(remote, branch)` (existing create-or-ff-then-checkout). If it already exists, skip checkout and call `rebaseOnto(sourceLocalName, to.name)` so a diverged local feature is not fast-forwarded away.
3. `checkoutBranchFor` / worktree guard uses `sourceLocalName`, not the remote ref.

Copy `confirmRebase` — do not add a parallel dialog. Two sequential IPC calls are acceptable: rebase already leases the source tip; a failed rebase after checkout leaves the user on the feature (conflict workspace or unchanged tip), which matches a manual checkout-then-rebase.

Alternative considered: one new `rebase_remote_onto` command. Rejected unless tests show a TOCTOU that the existing source-oid lease cannot cover.

### 3. Force-push on the action bar reuses the branch-menu preview

In `branchSync.ts` add `canForcePush` for `sync.status === "diverged"` only. Keep `canPush` false for that state (plain push is still a guaranteed non-fast-forward).

`useActionBarModel` / `ActionBar` expose a Force push `ToolbarAction` next to the disabled Push when `canForcePush`. Click path copies `destructiveActions.tsx`: `previewForcePush` → confirm (danger) → `forcePush(branch, preview)` with the leased route. No new command, no new secret path.

Keep the branch-menu item so a non-current diverged branch can still be force-pushed.

Size: `ActionBar.tsx` is already in the 201–400 look band; add only a toolbar row, keep logic in `actionBarModel` / `branchSync`. `graphActions.ts` and `ActionMenu.tsx` stay under the ceiling with the extra counterpart argument.

### 4. Tests that encode the old remote-drop rebase must flip

`graphActions.test.ts` “remote ref feed a local target” uses `origin/main` → `main` (counterpart) and MUST keep `rebase-target`. Add `origin/feature` → `main` expecting `rebase-source` labeled `Rebase feature onto main` and no `rebase-target`.

`menus.test.tsx` cases that click `Rebase main onto origin/feature` for a remote drop onto `main` MUST expect `Rebase feature onto main` and `rebaseOnto("feature", "main")` (plus checkout when `feature` is missing). Counterpart drop tests stay.

ActionBar diverged test: Push stays disabled; Force push is enabled and wired to the preview/confirm path.

## Risks / Trade-offs

- [Users who used remote-drop rebase to move develop onto a feature] → Mitigation: merge/FF/reset of the local target remain; “Integrate into current” on the remote’s branch menu still rebases HEAD onto that tip. Only the mislabeled rebase item goes away.
- [Checkout then rebase is two writes] → Mitigation: skip checkout when the local counterpart exists; rebase lease still pins the source oid. Conflicts stay in the existing rebase workspace.
- [Force-push on the toolbar is easier to hit] → Mitigation: same danger confirm + `--force-with-lease` abort as the branch menu; never auto-run after rebase.
- [Remote names with slashes] → Mitigation: reuse `remoteTrackingCheckoutCandidate` (already covers `team/tools/feature`).

## Migration Plan

Ship in one GitLane release. No data migration. Rollback is revert; no on-disk format change.

## Open Questions

None. Counterpart detection, command composition, and force-push placement are decided above.
