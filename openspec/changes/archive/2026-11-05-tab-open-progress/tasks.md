# Tasks

## 1. Store: pending-open state

- [x] 1.1 Add `pendingOpen: string | null` (default `null`, not persisted, not in `repoDataWipe`) to `RepoState` in `src/store/repoTypes.ts` and its initial value in `src/store/repo.ts`. Verify: `bun check`.
- [x] 1.2 In `loadRepo` (`src/store/repoLifecycleActions.ts`), set `pendingOpen = path` right after `openIntent.claim()`, before the first `await`. Verify: test 1.5 "set before openRepo resolves".
- [x] 1.3 Clear `pendingOpen` on every phase-1 exit per design D1 — with phase 2's publish on success; before `handleMissing` / `set({ error })` on failure; never when `pendingOpen !== path` or the open no longer owns the intent. Verify: tests 1.5.
- [x] 1.4 In `src/store/repoTab/closeRepo.ts` (and `dropRepoTab` if it is the shared exit), clear `pendingOpen` when it equals the closed path. Verify: test 1.5 "closed while pending".
- [x] 1.5 Add `src/store/repoLifecycle/pendingOpen.test.ts` (sibling of the ~1 000-line `loadRepo.test.ts`) with cases: set before `openRepo` resolves; cleared on success together with the published summary; cleared on a plain error and on a missing/`disconnected` error; A-then-B supersede where A resolves (and, separately, rejects) after B started leaves `pendingOpen === B`; closing the pending tab clears it and the late result does not re-add the tab. Verify: `bun run test src/store/` passes (the wipe-completeness test in `repoTabLifetime.test.ts` lists `pendingOpen` as carried).

## 2. Shared label helper

- [x] 2.1 Add a pure `openingLabel(path, session, displayName)` helper in `src/lib/` returning "Opening <name>…", "Connecting to <host>…", or "Installing GitLane agent — <stage> <percent>%" from the `RemoteSession` state (design D2/D3), with a node-project unit test covering local, `connecting`, `installing` with progress, and a remote session in any other state. Verify: `bun run test` for the new test file.

## 3. Tab indicator

- [x] 3.1 Add a `pending?: boolean` prop to `src/components/chrome/repo-tabs/ProjectTab.tsx` that sets `aria-busy="true"` on the tab at once, replaces the repo/server/tree icon with the accent `Spinner` after `TAB_SPINNER_DELAY_MS` (200 ms) and keeps it visible on hover, and uses `openingLabel` for the tooltip (dark: variant and focus ring unchanged). Verify: test 3.3.
- [x] 3.2 In `RepoTabStrip.tsx`'s `tabPropsFor`, read `pendingOpen` from `useRepo` and pass `pending: path === pendingOpen`. Verify: test 3.3.
- [x] 3.3 Extend `src/components/chrome/repo-tabs/RepoTabStrip.test.tsx`: with `pendingOpen` set to a background tab's path, that tab is `aria-busy` and shows the spinner while the active tab does not; for an `ssh://` tab with a `connecting` session the tooltip names the host. Verify: `bun run test src/components/chrome/repo-tabs/RepoTabStrip.test.tsx`.

## 4. Delayed workspace overlay

- [x] 4.1 Add `src/app-shell/OpeningOverlay.tsx`: reads `pendingOpen`, the tab display name, and the host's `useRemoteSessions` entry; renders nothing until the same non-null path has been pending for 400 ms, then a dimmed, pointer-blocking layer over the center pane using `Loading` with `openingLabel`. Timer resets when the path changes and clears on unmount. Verify: test 4.3.
- [x] 4.2 Mount it in `src/App.tsx` inside the body shell below the toolbar, suppressed on the restoring screen (title bar and tab strip stay interactive). Verify: test 4.3 and the manual check in 5.2.
- [x] 4.3 Add `src/app-shell/OpeningOverlay.test.tsx` with fake timers: nothing at 0 ms and at 399 ms; label visible after 400 ms; switching `pendingOpen` to another path restarts the delay and shows the new name; setting it to `null` removes the overlay; an `installing` session shows stage and percent. Verify: `bun run test src/app-shell/OpeningOverlay.test.tsx`.

## 5. Definition of done

- [x] 5.1 Run the check suite via the `verify` agent: `bun check`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes`, `bun run cycles` all exit 0 (no Rust changed, so Cargo checks are not required).
- [x] 5.2 Manual check in `bun run tauri dev`: switching between two local tabs shows no overlay flash; clicking an SSH tab after disconnecting the network or putting the host to sleep shows the tab spinner after ~0.2 s and, after ~0.4 s, "Connecting to <host>…"; the failure lands on the disconnected screen with Reconnect and the spinner/overlay are gone; clicking another tab mid-connect moves the indicator to it.
