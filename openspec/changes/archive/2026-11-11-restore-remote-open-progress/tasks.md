# Tasks

## 1. Store

- [x] 1.1 Add `Opening: "opening"` to `SESSION_RESTORE_PHASE` in `src/store/repoTypes/views.ts`, plus a pure `isRestoringShell(phase, pendingOpen)` helper returning true for `pending`/`restoring`, and for `opening` only while `pendingOpen` is non-null. Verify with a node unit test covering all three phases with and without a pending open.
- [x] 1.2 In `src/store/repoTab/restoreSession.ts`, set `sessionRestorePhase: opening` immediately before `await get().loadRepo(autoOpenTarget)`; leave the `finally` that sets `complete`. Verify in `src/store/repoLifecycle/session.test.ts`: with `openRepo` held pending, the phase reads `opening` and `pendingOpen` names the restored path; after `cancelPendingOpen()` `isRestoringShell` is false while the open is still unresolved, and resolving it later publishes no summary.

## 2. UI

- [x] 2.1 Export `OpeningLayer` from `src/app-shell/OpeningOverlay.tsx` (no behaviour change for `OpeningOverlay`). Verify `OpeningOverlay.test.tsx` still passes.
- [x] 2.2 In `src/App.tsx`, derive `restoringSession` with `isRestoringShell(sessionRestorePhase, pendingOpen)`, and in the `SHELL_VIEW.Restoring` branch render `<OpeningLayer path={pendingOpen.path} />` when `pendingOpen` is set, else the existing `Loading "Restoring workspace…"`. Keep the `OpeningOverlay` exclusion so the two never stack. Verify with a render test: a restoring shell with a pending SSH open and a `connecting` session shows "Connecting to <host>…" and a Cancel, and without a pending open shows "Restoring workspace…".

## 3. Verification

- [x] 3.1 Run `bun check`, `bun run test`, `bun run build`, `bun run sizes`, `bun run cycles` (via the `verify` agent); all exit 0.
- [x] 3.2 Manual check in `bun run tauri dev`: quit with an SSH tab active and the host unreachable or slow; relaunch shows the host and connecting phase with Cancel (not "Restoring workspace…"); Cancel shows the welcome screen with tabs intact; letting it run lands on the disconnected state with Reconnect.
