# Proposal

## Why

An implicit-state-machine audit (2026-11-07) found three child-process lifecycles that the Rust core encodes as loose flags instead of one owned state, and that can be driven into states the code does not expect:

- A Stop sent to an AI agent run before the adapter process is registered finds nothing to cancel, so it is dropped. The turn then runs on unwatched, still able to call tools, until it answers or the five-minute watchdog fires. `acp_prompt` waits on the blocking pool, which every git read shares, so on a busy repository that window is not just microseconds.
- `reap` signals the child's process group by the leader's pid. It is called after the leader has already been reaped: on every finished `timed::run`, after a Stop (`cancel` reaps, then `with_agent` reaps again), and when the watchdog races the normal exit. Once the leader is reaped, that pid may belong to an unrelated process group.
- The SSH askpass helper sets its "a question is open" flag around the call to the prompt and clears it afterwards, with no guard. If that call unwinds, the flag stays set. The connect watchdog then stops counting toward its timeout, so the connect can hang forever.

There is no Jira issue for this work.

## What Changes

- An agent run is recorded when `acp_prompt` is received, before it waits for the blocking pool. A Stop for a recorded run that has not spawned yet marks it cancelled. The run then refuses to spawn, or ends its child right after registering it. A Stop for a run id that is not recorded, for example one that already finished, stays a no-op that returns `false`.
- A child process and its process group are stopped and collected exactly once. The child is kept as an owned slot that `reap` empties. The group is signalled only while its leader is still unreaped and so still pins the group id. Later `reap` calls for the same child do nothing. This applies to `shell/timed.rs` and to `acp/process.rs`, which share `reap` and `watchdog`.
- The askpass "question open" flag is cleared by a drop guard, so it is cleared however the prompt call ends.

Each of the three is independent and lands with its own tests (see tasks.md groups 1–3).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `terminal/session`: adds requirements that a Stop sent before the agent starts still ends the run, and that stopping a run never signals a process outside it.
- `remote/ssh-repos`: adds a requirement that an open ssh question pauses the connect timeout only while it is open.

## Non-goals

- Making `with_agent`'s `RUNNING` map or the clone, sign-in and OAuth slots into one shared "run registry" abstraction. Each fix stays in the module that owns the lifecycle.
- Frontend changes. `useAiActionRun` and `useAiResolveRuns` already send the Stop. This change only makes the backend honour it.
- The remote session `Connected`/`Disconnected` ordering. That is already fixed on the `fix/remote-session-state-events` branch.
- The other audit findings: the repo-open `repoPhase` union, phase-plus-payload run hooks, and `{loading, error, data}` bundles. They are frontend refactors for separate changes.
- Changing the five-minute agent watchdog, the hello timeout, or `PROMPT_TIMEOUT`.

## Impact

- Process: **Rust only.** There is no IPC signature change. `acp_prompt` and `acp_cancel` keep their arguments and return types, so the TS API and `generate_handler!` are untouched.
- Code:
  - `src-tauri/src/acp/process.rs`: the run registry, cancel, and the spawn checks.
  - `src-tauri/src/commands/terminal.rs`: `acp_prompt` records the run before `blocking`.
  - `src-tauri/src/shell/timed.rs`: `reap`, `watchdog` and `run` move to an owned child slot.
  - `src-tauri/src/remote/askpass.rs`: the `prompting` guard.
- Pattern to copy: the GitHub sign-in's pre-arm (`arm_sign_in` / `ready_to_spawn` / `PendingGuard` in `src-tauri/src/git/forge/signin/flow.rs`) for the early Stop, and the `Mutex<Option<Child>>` slot already used by `remote/connect.rs` and `remote/session.rs` for reaping once.
- Secrets, auth and IPC risk: none. No credential crosses any new boundary. The agent's environment, including the removal of `ANTHROPIC_*` keys, is unchanged. Process-group signalling gets narrower, never wider.
