# Tasks

Groups 1–3 are independent. Each one is complete with its own tests and checks, and none depends on another group's code, so they can be implemented and landed in any order. Group 1 builds on the existing `reap(&Arc<Mutex<Child>>)`. If group 2 lands first, group 1 uses its `ChildSlot`, and the only difference is that type name.

## 1. A Stop sent before the agent starts still ends the run (terminal/session)

- [x] 1.1 Move `acp/process.rs`'s inline `mod tests` to `src-tauri/src/acp/process/tests.rs` (leaving `#[cfg(test)] mod tests;`), unchanged. Verify `cargo test acp::process` passes with the same test count as before.
- [x] 1.2 In `acp/process.rs`, replace the `RUNNING` map's value with `Run { Pending { stopped: bool }, Live(child) }`. Add `pub fn arm(run_id) -> RunGuard`: it inserts `Pending`, is a no-op for an empty id, and its `Drop` removes the entry. Verify with a test that arming and then dropping the guard leaves no entry.
- [x] 1.3 Rework `cancel(run_id)` per design §1. On `Pending`, it sets `stopped` and returns `true`. On `Live`, it removes the entry and reaps outside the map lock, returning `true`. On an absent entry, it returns `false`. Verify with tests for all three cases.
- [x] 1.4 In `with_agent`, add the pre-spawn check (return "Agent run stopped." without spawning when `stopped`). Add the post-spawn registration: `Pending{false}` becomes `Live`; `Pending{true}` reaps the new child and returns the stopped error; an unarmed non-empty id registers `Live` as today. Verify with unix tests using `sh -c 'sleep 30'`: a Stop before launch spawns nothing; a Stop that lands between the checks leaves no live child.
- [x] 1.5 In `commands/terminal.rs` `acp_prompt`, call `acp::arm(&run_id)` before `blocking(...)` and move the guard into the closure. Re-export `arm` from `acp.rs` next to `cancel`. Verify `cargo test commands::registration_tests` passes: thread placement and remote split are unchanged, and no command signature changed.
- [x] 1.6 Read `src/features/agents/ai-actions/useAiActionRun.ts` and `src/features/conflicts/ai-resolve/useAiResolveRuns.ts`. Confirm that a rejected `acp_prompt` for a run the user stopped is discarded and not shown as an error. If either one shows it, record that here as a finding and do not change the frontend in this group.
- [x] 1.7 Run the group's checks and verify each exits 0: `cargo fmt --all -- --check`; `cargo clippy --all-targets --all-features -- -D warnings`; `cargo clippy --all-targets --no-default-features --features agent -- -D warnings`; `cargo test acp::`; `bun run sizes`, which keeps `acp/process.rs` under 400 production lines.
- [ ] 1.8 Manual check with `bun run tauri dev`. Start an AI action (Describe) and press Stop at once. Verify the banner clears, no answer lands, and `ps -o pid,pgid,command | grep -i acp` shows no adapter left running.

## 2. Reap each child exactly once (terminal/session)

- [x] 2.1 Move `shell/timed.rs`'s inline `mod tests` to `src-tauri/src/shell/timed/tests.rs`, unchanged. Verify `cargo test shell::timed` passes with the same test count.
- [x] 2.2 In `shell/timed.rs`, introduce `ChildSlot = Arc<Mutex<Option<Child>>>`. Make `reap(&ChildSlot) -> Option<ExitStatus>` take the child out and do nothing when the slot is empty. Make `watchdog` take the slot. Verify with a test that calling `reap` twice on the same slot signals and waits once, and that the second call returns `None`.
- [x] 2.3 In `output_within`, replace the `try_wait` poll on unix with a non-collecting exit check (`libc::waitid` with `WEXITED | WNOHANG | WNOWAIT`), and take the exit status from `reap`. Keep `try_wait` under `cfg(not(unix))`. Verify that the existing `a_command_that_finishes_returns_its_stdout`, `a_hanging_command_is_killed_at_its_timeout` and `reap_kills_the_childs_group_and_nothing_outside_it` still pass. Add a test that a command exiting non-zero still returns `None`.
- [x] 2.4 Move `acp/process.rs` to the slot: `Run::Live` (or today's map value, if group 1 has not landed), `watchdog`, and the end-of-run `reap`. Verify with a unix test that after `cancel(run_id)` the end-of-run `reap` finds the slot empty and sends no signal.
- [x] 2.5 Run the group's checks and verify each exits 0: `cargo fmt --all -- --check`; both `cargo clippy` invocations from 1.7; `cargo test shell::` and `cargo test acp::`; `bun run sizes`.

## 3. Clear the askpass "question open" flag by scope (remote/ssh-repos)

- [ ] 3.1 In `remote/askpass.rs` `answer_one`, replace the `prompting.store(true)` / `store(false)` pair with a `Prompting` guard: it stores `true` on creation and `false` on `Drop`. Verify with a test in `remote/askpass/tests.rs`: an `ask` closure that panics, run under `std::panic::catch_unwind`, leaves `prompting(&origin)` false.
- [ ] 3.2 Run the group's checks and verify each exits 0: `cargo fmt --all -- --check`; both `cargo clippy` invocations from 1.7; `cargo test remote::`; `bun run sizes`.

## 4. Integration

- [ ] 4.1 With all three groups in, run `cargo test` (whole crate) and `bun run test`. Verify both pass. The frontend suite confirms there is no IPC fixture drift (`src/test/ipcFixtures.ts`).
