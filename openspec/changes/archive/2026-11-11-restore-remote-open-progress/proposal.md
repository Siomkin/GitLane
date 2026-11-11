# Proposal

## Why

When GitLane relaunches with an SSH repository as the active tab, the whole body shows "Restoring workspace…" until the host connects, the agent installs, or the connect times out. That can take many seconds. The screen never says which host it is waiting on, what phase it is in, or how to stop waiting. A slow open started any other way already shows all three through the opening overlay, but launch restore hides that overlay (`App.tsx` renders it only when the shell is not in the restoring view).

## What Changes

- Once launch restore has finished its disk probe and is opening the last active tab, the restoring screen shows the same content as the opening overlay: the repository's name, the SSH host, the connection phase (connecting, installing the agent with stage and percent), the locator, and a Cancel.
- "Restoring workspace…" stays only for the short disk-probe step before any repository open starts.
- Cancel on that screen abandons the restore's open: the screen falls through to the welcome screen with the tab strip intact, and the open finishing or failing later changes nothing. Clicking the remote tab later opens it normally.
- Local repositories restore the same way; a fast local restore still shows no overlay flash beyond today's brief restoring screen.

## Non-goals

- No change to how or when SSH connects, the connect timeout, agent install, or the SSH prompt dialog (it already shows over the restoring screen).
- No change to the disconnected / missing-repository screen a failed restore lands on.
- No new IPC command, Rust change, or remote-session event.
- No restyle of the opening overlay.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chrome/repo-tabs`: the slow-open overlay requirement gains the launch-restore route, so a restored SSH tab names its host, phase, and offers Cancel instead of a generic restoring message.

## Impact

- Process: frontend only. No Rust, no IPC, no secrets or auth handling touched.
- Jira: none yet.
- Code: `src/App.tsx` (restoring branch), `src/app-shell/OpeningOverlay.tsx` (reuse `OpeningLayer` without the delay), `src/store/repoTab/restoreSession.ts` and `src/store/repoTypes/views.ts` (a restore phase that marks the hand-off to `loadRepo`). Copy the existing `OpeningLayer` and `openingLabel` rather than adding a new progress view.
- Tests: `restoreSession` tests, `OpeningOverlay.test.tsx`, `shellView` tests.
