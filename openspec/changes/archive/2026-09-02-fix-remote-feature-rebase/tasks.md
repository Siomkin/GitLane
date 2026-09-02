## 1. Graph drop policy

- [x] 1.1 Extend `buildGraphActionSpecs` with `sourceLocalName` and, when a remote source is dropped on a different local branch, replace `rebase-target` with `rebase-source` labeled `Rebase {sourceLocalName} onto {target}`; verify `graphActions.test.ts` keeps `origin/main` → `main` as `rebase-target` and adds `origin/feature` → `main` as `rebase-source` with no `rebase-target`
- [x] 1.2 Leave merge / fast-forward / reset of the local target onto a remote unchanged and verify those kinds still appear for a remote-feature drop onto `develop`

## 2. Rebase handler (compose existing writes)

- [x] 2.1 In `ActionMenu`, resolve the remote counterpart via `remoteTrackingCheckoutCandidate`, confirm with `confirmRebase` naming that local branch, and on confirm call `rebaseOnto(localName, target)` — `checkoutRemoteBranch` only when the local counterpart is missing; verify menu tests that currently click `Rebase main onto origin/feature` now confirm `Rebase feature onto main` and call `rebaseOnto("feature", "main")`
- [x] 2.2 Guard checkout-based rebase with `findOtherBranchWorktree` on the **local counterpart** (not the remote ref) and verify the existing worktree-held disable case still blocks rebase of a held feature
- [x] 2.3 Verify a missing local counterpart triggers `checkoutRemoteBranch` then `rebaseOnto`, and that cancelling the confirm calls neither

## 3. Force-push from the push chrome

- [x] 3.1 Add `canForcePush` in `branchSync.ts` for `diverged` only (keep `canPush` false) and verify unit coverage for ahead / behind / diverged / noUpstream
- [x] 3.2 Expose Force push on the action bar beside disabled Push when the current branch is diverged, copying the branch-menu `previewForcePush` → danger confirm → `forcePush` path; verify `ActionBar.test.tsx` keeps Push disabled and enables Force push wired to that preview
- [x] 3.3 Keep the branch-menu force-push item and verify its existing menu test still runs the leased preview/confirm path

## 4. Definition of done

- [x] 4.1 Run `bunx tsc --noEmit`, `bun run lint`, `bun run test` on the touched frontend files (`graphActions`, menus, `branchSync`, ActionBar), `bun run sizes`, and `openspec validate fix-remote-feature-rebase --store gitlane`, and verify they pass
- [ ] 4.2 Exercise in `bun run tauri dev`: drop a remote feature onto `develop` and confirm the feature (not develop) moves; rebase a checked-out local feature onto `develop`; when `↑n ↓1`, Force push with lease updates the remote and the two pills coincide — without adding a new IPC command
