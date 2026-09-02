## Why

Rebasing a remote feature onto a local base (for example dropping `origin/my-feature` onto `develop`) currently moves the **base**: the drop menu treats the remote as read-only, so the only rebase offered is “Rebase develop onto the remote.” After the user checks the feature out locally and rebases it correctly, the rewritten local branch and the stale remote-tracking ref both sit on the graph (`↑n ↓1` / diverged) and the action-bar Push is disabled — force-with-lease exists only in the branch danger menu, so publishing the rebase looks impossible.

No Jira key (GL-xx) for this change.

## What Changes

- When the user asks to rebase a **remote-tracking feature** onto a **local base that is not that feature’s counterpart**, GitLane MUST replay the feature (via its local counterpart, creating/checking it out if needed) onto the base. It MUST NOT rebase the base onto the remote.
- Integrating a remote **into its own local counterpart** (update `feature` from `origin/feature`) keeps today’s direction: the local branch moves onto the remote.
- Merge / fast-forward / reset of a local branch onto a remote stay available as separately labeled integrate actions. They are not the default rebase when the remote is a different branch.
- After a published branch is rewritten and diverges from its upstream, the user MUST be able to update that remote with the existing `--force-with-lease` preview/confirm flow from a control that is visible in the same place they push (not only buried as a danger-zone item). Regular Push stays disabled for `diverged`.
- Confirmation copy MUST name the branch that will move and the commit it will land on, including the checkout prerequisite.

## Capabilities

### New Capabilities

- `history/write-ops`: Rebase operand direction for remote-tracking vs local branches, and publishing a rewritten local branch to its upstream with force-with-lease when the histories have diverged.

### Modified Capabilities

- None. There is no main spec for this capability yet.

## Impact

- Frontend (primary): `src/lib/graphActions.ts` remote-source drop policy; graph `ActionMenu` / `rebaseConfirm`; branch-menu integrate vs danger force-push; action bar when sync is `diverged`.
- Existing writes to compose (copy these, do not invent a parallel path): `checkout_remote_branch`, `rebase_onto` (`git rebase <onto> <source>` with both operands), `preview_force_push` / `force_push` (`--force-with-lease`).
- Rust/IPC: no new command unless design proves checkout+rebase must be one leased git process. No new secrets path — push keeps the existing credential/transport stack. Tokens never enter JS/Zustand.
- Tests: `graphActions.test.ts`, graph/branch menu tests that today assert “Rebase main onto origin/feature” as the only remote-drop rebase, ActionBar diverged Push-disabled case, existing remotes force-push fixtures.

## Non-goals

- Blind `--force` (no lease) or auto force-push immediately after rebase.
- Rebasing or deleting the remote-tracking ref in the local object database as if it were a writable branch.
- Changing merge, cherry-pick, squash, or conflict-resolution UI.
- Pushing a branch that has no upstream (publish/set-upstream stays as today).
- Rewriting graph layout math.
