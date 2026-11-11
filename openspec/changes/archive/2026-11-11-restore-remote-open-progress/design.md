# Design

## Context

Launch restore (`src/store/repoTab/restoreSession.ts`) sets `sessionRestorePhase` to `restoring`, probes the persisted tabs, then `await get().loadRepo(lastPath)` and only sets `complete` in `finally`. For an SSH tab that await lasts the whole connect / agent install / timeout.

`App.tsx` maps `sessionRestorePhase !== complete` (with no summary and no missing repo) to `SHELL_VIEW.Restoring`, which renders `<Loading label="Restoring workspace…" />` and suppresses `<OpeningOverlay />`. `loadRepo` already publishes `pendingOpen` for this open, and `OpeningLayer` + `openingLabel` already turn `pendingOpen` plus the remote session state into "Connecting to host…" / "Installing GitLane agent — stage N%" / "Opening name on host…" with a Cancel. Nothing new needs to be derived; the restoring screen just never shows it.

`cancelPendingOpen` only clears `pendingOpen`; the open stands down when it resolves. Restore keeps awaiting it, so the phase would stay `restoring` after Cancel unless the shell stops reading that phase as "restoring" once the hand-off's pending open is gone.

Engine: none. No Rust, no IPC, no new dependency. Store: `repo` only (`SessionRestorePhase`).

## Goals / Non-Goals

**Goals:** reuse `OpeningLayer` for the restore's open; make Cancel leave the restoring screen immediately.

**Non-Goals:** changing `loadRepo`, connect timeouts, or the restore's tab reconciliation.

## Decisions

1. **New phase `opening`.** `restoreSession` sets `sessionRestorePhase: opening` just before `await get().loadRepo(autoOpenTarget)`; `finally` still sets `complete`. `App.tsx` derives `restoringSession = phase === pending || phase === restoring || (phase === opening && pendingOpen !== null)`. After Cancel, `pendingOpen` is null, so the shell falls to onboarding (welcome) at once while the stale open stands down on its own.
   - Alternative: set `complete` before awaiting `loadRepo`. Rejected: the shell would show onboarding until the 400 ms overlay delay passes, flashing the welcome screen on every launch.
   - Alternative: make `cancelPendingOpen` abort the restore. Rejected: cancel is deliberately marker-only; adding restore coupling to it is more state than one phase value.

2. **Restoring view renders `OpeningLayer` with no delay when `pendingOpen` is set.** Export `OpeningLayer` from `OpeningOverlay.tsx` and render it in the `SHELL_VIEW.Restoring` branch in place of `Loading` whenever `pendingOpen` exists. No delay: there is no repository behind it to protect from a flash, and it replaces an already-visible spinner. The overlay's absolute positioning already fills the shell's positioned container. Before the hand-off, keep `Loading "Restoring workspace…"`.
   - The `OpeningOverlay` exclusion in `App.tsx` stays, so the two never stack.

3. **`shellView` unchanged.** It already takes a boolean `restoringSession`; only App's derivation of that boolean changes. Put the derivation in a small pure helper next to `SESSION_RESTORE_PHASE` (`isRestoringShell(phase, pendingOpen)`) so it is unit-testable in the node project.

## Risks / Trade-offs

- [A local restore that takes a moment now shows "Opening name…" with Cancel instead of "Restoring workspace…"] → Acceptable and more accurate; the spec only forbids a Cancel flash on a quick open, and a quick local open is gone before paint in practice. If it flashes in practice, gate the layer on `OPENING_OVERLAY_DELAY_MS` like `OpeningOverlay` and keep `Loading` under it.
- [Any other reader of `sessionRestorePhase !== complete`] → only `App.tsx` reads it today (checked); the new phase is still "not complete" for anything added later.
- [Size ceilings] → `App.tsx` and `OpeningOverlay.tsx` are small; no split needed.
