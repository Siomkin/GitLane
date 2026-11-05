# Design

## Context

See proposal.md (Why). Every open funnels through `loadRepo` in
`src/store/repoLifecycleActions.ts`:

1. **Phase 1** — `await api.openRepo(path)`. For an `ssh://` locator this goes through
   `remote_invoke` → `session_for`, which connects (`ssh -T`), may install the agent, and emits
   `remote-session-changed` (`connecting` / `installing` with `{ stage, percent }` / `connected` /
   `failed`). `useRemoteSessions.byOrigin` already holds that per host, and `ProjectTab` already
   subscribes to it. On a session whose TCP died during sleep, `Session::request` waits until `ssh`'s
   keep-alive gives up (up to ~45 s) and then fails as `disconnected`.
2. **Phase 2** — `publishRepoSwitch` atomically publishes the summary, inserts/activates the tab,
   and raises `loading`/`graphLoading` (the history skeleton).

GL-20 requires phase 1 to touch no shared state, so a failed open never disturbs the repository on
screen. That is why nothing visible happens today until phase 2. Ownership during phase 1 is
already tracked by `openIntent` plus per-tab lifetime leases (`openOwnerIsCurrent()`).

Engine: none — this is pure frontend; no read/write/forge path, no IPC command, no event, no Rust.

## Goals / Non-Goals

**Goals:**
- One store field that says "this path's open is pending", owned by the same guards that already
  decide whether a phase-1 result may publish.
- Tab indicator and delayed body overlay both derived from that field plus the host's existing
  remote session state.

**Non-Goals:**
- Reusing `loading` / `graphLoading` for phase 1 (would break GL-20; they make the history view
  drop to the skeleton).
- New remote events or a Rust-side liveness probe (proposal Non-goals).

## Decisions

### D1. A dedicated `pendingOpen: string | null` in the repo store

`loadRepo` sets `pendingOpen = path` synchronously right after `openIntent.claim()`, before the first
`await`. It clears it (sets `null`) only if `get().pendingOpen === path` **and** the open still owns
the intent, at each phase-1 exit:

- success: in the same `set` path as `publishRepoSwitch` (phase 2), so there is no frame where
  neither the indicator nor the skeleton shows;
- failure: before `handleMissing` / `set({ error })`, inside the existing `openOwnerIsCurrent()`
  branch;
- superseded / stale result: a newer `loadRepo` has already overwritten `pendingOpen` with its own
  path, so the stale path's equality check fails and it leaves the field alone;
- tab closed while pending: `closeRepo` / `dropRepoTab` clears `pendingOpen` when it equals the
  closed path (the stale `loadRepo` then returns through its lease check without touching it).

The superseded-but-not-current failure path (a stale open that fails after the user moved on) must
also not clear — covered by the equality check.

*Alternatives:* a counter or a set of pending paths — rejected: the spec says only the latest open is
shown, and `openIntent` already serialises "latest wins". Local state in `RepoTabStrip.onSelect` —
rejected: shortcuts, recents, session restore and `locateMissingRepo` all call `loadRepo` and should
light the same indicator.

`pendingOpen` is transient: not persisted, and not part of `repoDataWipe` (phase 2 clears it
explicitly).

### D2. Tab indicator via a `pending` prop on `ProjectTab`

`RepoTabStrip.tabPropsFor` passes `pending: path === pendingOpen`, mirroring the existing `missing`
prop. `ProjectTab` sets `aria-busy` at once and, after `TAB_SPINNER_DELAY_MS` (200 ms) of
staying pending, swaps its folder/server/tree icon for the accent `Spinner`
(`src/components/ui/Loading.tsx`), so a fast local switch never blinks. The spinner ignores the
tab's hover-to-drag-handle swap; the drag handle stays usable but is drawn invisible over it. For a remote tab the tooltip reads the
host's session already subscribed in `ProjectTab`: `connecting` → "Connecting to <host>…",
`installing` → "Installing GitLane agent — <stage> <percent>%", otherwise "Opening…".

### D3. Delayed overlay over the center workspace

A small `OpeningOverlay` in `src/app-shell/`, mounted by `App.tsx` inside the always-mounted body
shell below the toolbar (not inside `CenterWorkspace`, so it also covers the missing-repo and welcome
screens an open can start from; suppressed while the startup "Restoring workspace…" screen shows),
reads `pendingOpen` and shows nothing until it has stayed the same non-null path for 400 ms (a
`setTimeout` keyed on the path; reset when it changes). It then renders a dimmed, pointer-blocking
layer over the body only (the title bar and tab strip stay clickable, so the user can switch
to another tab, which supersedes). Its label is the repository's tab display name, or — for an SSH
locator — the same phase text as D2, derived by one shared pure helper (e.g. `openingLabel(path,
session, displayName)` in `src/lib/`) so tab and overlay never disagree. Uses `Loading` for the
spinner + label.

*Alternative:* switching the body to an empty loading screen at once — rejected: it would have to
drop the current repository before the open is known to succeed, which is exactly what GL-20 forbids.

### D4. Size

`repoLifecycleActions.ts` is 292 lines (in the 201–400 look band). The additions are a handful of
guarded `set` calls; no split is due. If it crosses ~350 during apply, move the pending-open
bookkeeping into `src/store/repoLifecycle/` beside `publishSwitch.ts`.

## Risks / Trade-offs

- [The pending field gets stuck on an exit path nobody cleared] → every phase-1 return is enumerated
  in D1 and each gets a store test in `repoLifecycle/pendingOpen.test.ts` (a sibling of the
  ~1 000-line `loadRepo.test.ts`); the overlay never blocks the tab strip, so a
  stuck state is still escapable by clicking another tab.
- [A ~45 s dead-session wait still feels long, now with a visible overlay] → accepted for this change;
  the overlay at least says "Connecting to <host>…". Faster detection is a named follow-up.
- [Session restore at startup shows the overlay over an empty workspace] → harmless; it is the
  same "Opening <name>…" message the user would expect at launch.
