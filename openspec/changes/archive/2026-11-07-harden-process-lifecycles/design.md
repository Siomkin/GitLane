# Design

## Context

There is no git engine choice here. None of the three touches git: they are process lifecycles in the Rust core. There is no Zustand store change and no new IPC command or argument.

The current shapes:

- **Agent runs** (`acp/process.rs`). `RUNNING: BTreeMap<run_id, Arc<Mutex<Child>>>` holds a run from the point its child is registered, after the spawn and stdio setup (lines 106–113), until the session ends. `cancel(run_id)` removes the entry and reaps the child, or returns `false` if the entry is absent. `acp_prompt` (`commands/terminal.rs:141`) goes straight into `blocking(...)`, so a Stop can arrive while it waits for the pool. `acp_cancel` also runs on the pool, so the two calls are not ordered.
- **Reaping** (`shell/timed.rs`). `reap(&Arc<Mutex<Child>>)` calls `kill_group(pid)`, `kill`, then `wait`. The comment at line 90 assumes the leader is still unreaped, but three paths call `reap` after a wait has already reaped it:
  - `output_within` reaps after `try_wait` returned `Some`.
  - `with_agent` reaps at line 121 after `cancel` already did.
  - The watchdog can reap after the normal path did.
- **Askpass** (`remote/askpass.rs:262–266`). `prompting.store(true)`, then `ask(..)`, then `store(false)`. The hello watchdog in `remote/connect.rs:197` skips counting while `prompting(&origin)` is true.

The size bands for the files touched (production lines; inline tests are counted apart):

| File | Lines | Band |
|---|---|---|
| `acp/process.rs` | 299 | look band (251–400); stays under 400 after this change |
| `shell/timed.rs` | ~100 | clear |
| `remote/askpass.rs` | ~360 | look band; this change adds a few lines only |
| `commands/terminal.rs` | 262 | look band; this change adds a few lines only |

## Goals / Non-Goals

**Goals:**

- Each lifecycle has one owner that makes illegal states unrepresentable:
  - a run is pending, or live with a child;
  - a child slot is full until it is reaped exactly once;
  - the "question open" flag is cleared by scope.
- The three fixes are independent. Each can land, be reviewed and be reverted on its own: no group depends on another group's code.

**Non-Goals:** see proposal.md. Additionally:

- No shared generic "process supervisor" type.
- No change to Windows behaviour, which has no process groups here.

## Decisions

### 1. An early Stop: record the run before the pool, as GitHub sign-in does

`acp/process.rs` gains a run state:

```text
enum Run { Pending { stopped: bool }, Live(ChildSlot) }
```

- **`acp::arm(run_id)`** inserts `Pending { stopped: false }` and returns a `RunGuard` whose `Drop` removes the entry. `acp_prompt` calls it in the async fn before `blocking`, and moves the guard into the closure. An empty `run_id`, as the probe path uses, is never armed: the same rule as today.
- **`cancel(run_id)`**:
  - on `Pending`, it sets `stopped = true` and returns `true`;
  - on `Live`, it removes the entry and reaps outside the map lock (as today), returning `true`;
  - on an absent entry, it returns `false` (unchanged).
- **`with_agent`** checks twice:
  - Before the spawn: if the run is `Pending { stopped: true }`, it returns the stopped error without spawning.
  - After the spawn: it creates the child slot and, under the map lock, moves `Pending { stopped: false }` to `Live(slot)`. If the entry is now `Pending { stopped: true }`, it reaps the slot and returns the stopped error.
  - A run id that was never armed but is not empty is registered as `Live` directly, which keeps every caller outside `acp_prompt` working as today.
- **The stopped error** is a plain string ("Agent run stopped."), like the existing `Err(String)` outcomes. Both frontend callers already discard the result of a run they stopped. Task 1.6 confirms this by reading the code, not by changing it.

Two alternatives were rejected:

- **A tombstone set of cancelled ids written by `cancel` for unknown ids.** It cannot tell "not started yet" from "already finished", so it would grow with every late Stop.
- **Spawning while holding the map lock.** It is simpler, but it blocks every other Stop for the length of a `spawn()`, which is an `npx` launch on Windows.

This copies the `arm_sign_in` → `ready_to_spawn` → `PendingGuard` sequence in `git/forge/signin/flow.rs`, with one difference: the guard removes the run's own entry rather than clearing shared flags. That avoids the "a later run's cleanup erases an earlier cancel" shape the sign-in slot has.

### 2. Reaping exactly once: an owned slot, and signalling before any wait

`shell/timed.rs` defines:

```text
type ChildSlot = Arc<Mutex<Option<Child>>>
```

This is the shape already used by `remote/connect.rs:111` and `remote/session.rs:59`.

- **`reap(&ChildSlot) -> Option<ExitStatus>`** takes the child out of the slot. If the slot is already empty, it does nothing and returns `None`. Otherwise it calls `kill_group(pid)`, then `kill`, then `wait`, and returns the wait's status. The leader is reaped only here, so it is still unreaped, and so still pins its group id, whenever `kill_group` runs.
- **`watchdog`** takes the slot, and its timeout path is `reap`.
- **`output_within`** must not reap through `try_wait`. After stdout closes:
  - On unix, it polls for exit with `waitid(P_PID, pid, WEXITED | WNOHANG | WNOWAIT)`, through `libc`, which is already a dependency. That reports the exit without collecting the process. The exit status then comes from `reap`'s `wait`, after the group signal has cleared any stray grandchild. Signalling the group of an exited (zombie) leader cannot change that leader's recorded status.
  - On Windows, where there are no groups, it keeps `try_wait`, and `reap` becomes a no-op.
- **In `acp/process.rs`**, `Run::Live` and `with_agent`'s end-of-run `reap` share the slot. After a Stop, the second `reap` finds the slot empty and does nothing.

Alternative rejected: keep `Arc<Mutex<Child>>` and check `try_wait()` before `kill_group`. `try_wait` itself reaps the leader, so the check would cause the very hazard it is meant to prevent.

### 3. Askpass: a drop guard for `prompting`

`answer_one` wraps the `ask` call in a small guard: `struct Prompting<'a>(&'a AtomicBool)`. It stores `true` on creation and `false` on `Drop`, so a panic unwinding through `ask` still clears the flag. This is the only change. `PROMPT_TIMEOUT` and the hello watchdog are untouched.

### Tests

Following the sibling layout (`remote/askpass/tests.rs`, `remote/registry/tests.rs`), new tests go in `foo/tests.rs` files.

- `acp/process.rs`'s inline `mod tests` (about 130 lines) moves to `acp/process/tests.rs` in group 1, before new tests are added. The block would otherwise pass the ~150-line split point of architecture-rules-rust.md §6.
- `shell/timed.rs`'s inline tests move to `shell/timed/tests.rs` in group 2, for the same reason and to match.

The run-state tests (group 1) drive `arm`, `cancel` and the registration step directly with a real short-lived child (`sh -c 'sleep 30'`, unix-only, like the existing timed tests), so they need no adapter.

## Risks / Trade-offs

- **`WNOWAIT` is unix-specific.** It is in POSIX and available on macOS and Linux, the only unix targets. Windows keeps today's path, which has no group signal to get wrong.
- **Group signal on a successful `output_within`.** The group now always receives SIGTERM after the leader exits, which already happens today through `reap`. Only the ordering changes: the signal comes before the leader is collected rather than after.
- **The window between the two `with_agent` checks.** A Stop that lands between the pre-spawn check and registration sets `stopped`, and the registration step then reaps the new child. The adapter may run for the few milliseconds before that. This is accepted: it is the same window `cancel` already has for a live child.
- **Re-used run ids.** The frontend generates a fresh id per run. If one were re-used while its first run is still in flight, `arm` would overwrite that run's entry. This is documented in a code comment, not guarded, because no caller does it.
