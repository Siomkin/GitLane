# Proposal

## Why

Clicking a repository tab in the title bar gives no sign that anything is happening until the
repository has opened. `loadRepo`'s phase 1 (`api.openRepo`) deliberately touches no shared state
(GL-20), so the old repository stays on screen, the clicked tab stays inactive, and nothing moves.
For a local repository that is usually instant, but for an SSH tab — especially after the machine
was idle — phase 1 may reconnect `ssh`, re-install the agent, or wait out a dead connection, which
can take seconds and sometimes ends in an error. The user cannot tell whether the click registered.

There is no Jira issue for this yet.

## What Changes

- While a tab's open is pending (phase 1 of `loadRepo`), that tab shows a busy indicator in place
  of its folder/server icon, so the click is acknowledged at once.
- For an SSH tab, the indicator's tooltip and the body overlay name the remote phase already
  tracked per host in `useRemoteSessions` — connecting, installing the agent (with progress) —
  instead of a generic "Opening…".
- If phase 1 is still pending after a short delay (~400 ms), the center workspace shows a
  non-destructive loading overlay ("Opening <name>…" / "Connecting to <host>…") over the
  repository still on screen. Fast local opens never flash it.
- The indicator and overlay clear when the open publishes (phase 2), fails (the error bar, the
  missing-repo screen, or its `disconnected` kind take over exactly as today), is superseded by
  another open, or the pending tab is closed.
- **Decision:** both a tab indicator and a delayed body overlay. The tab indicator answers "did my
  click register"; the overlay answers "what is it doing" for the multi-second remote case. The
  delay keeps local switches looking exactly as they do now.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `chrome/repo-tabs`: adds a requirement that opening a tab shows progress until the repository is
  on screen or the open has failed.

## Non-goals

- Shortening how long a dead SSH session takes to fail. Today a request on a session whose TCP
  died during sleep waits until `ssh`'s `ServerAliveInterval=15 × ServerAliveCountMax=3` kills it
  (up to ~45 s), then fails as `disconnected`. Detecting that faster (a liveness ping on focus or
  before the first request) is a separate change.
- A cancel button. Clicking another tab already supersedes the pending open (`openIntent`).
- Progress for phase 3/4 (graph, side effects): the history skeleton already covers those.
- Progress for opening a path that has no tab yet (recents, Open…): the body overlay covers it,
  but no new tab is inserted before phase 2 publishes; tab placement stays in `publishRepoSwitch`.
- Any change to the remote protocol, Rust, or IPC.

## Impact

- **Process:** frontend only. No Rust, no IPC command, no new event.
- **Store:** `src/store/repoLifecycleActions.ts` (`loadRepo`) gains a pending-open field in the
  repo store, set before `api.openRepo` and cleared under the existing `openOwnerIsCurrent()`
  guards. Every `loadRepo` caller (tab click, ⌘-number shortcut in `useShortcuts.ts`, recents,
  startup restore, `locateMissingRepo`) gets the indicator for free.
- **UI:** `src/components/chrome/repo-tabs/ProjectTab.tsx` (copy its `missing` prop pattern for a
  `pending` prop; it already subscribes to the host's remote session), `RepoTabStrip.tsx`, and
  the center workspace in `src/app-shell/CenterWorkspace.tsx` for the overlay.
- **Tests:** `src/store/repoLifecycle/loadRepo.test.ts`, `RepoTabStrip.test.tsx`.
- **Secrets/auth:** none touched; the overlay reads only the non-secret session state and
  progress already in `useRemoteSessions`.
