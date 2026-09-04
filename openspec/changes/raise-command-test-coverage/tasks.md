## 1. Rust — cover the 20 uncovered implementation functions

- [x] 1.1 Add tests for `acp_agents::{reset, save}` and `terminal_agents::{save, load_messages, save_messages, reset_messages_to_defaults, reset_to_defaults}` using a temp app-config dir; verify round-trip, reset-to-defaults, and malformed-JSON recovery
- [x] 1.2 Add tests for `git::write::branches::rename_branch` and `git::write::staging::stage_all` under `git/write/tests/{branches,staging}/` using the existing fixture helpers in `git/write/tests/support`; verify success, leading-dash operand refusal, and the `-m` no-clobber guarantee (neither function takes a stale lease — `rename_branch` guards with `ensure_operand`, `stage_all` with the index lock — so lease rejection does not apply here)
- [x] 1.3 Add tests for `git::read::default_identity`, `git::credentials::helper_status`, `signing_keys::list`, `auth_providers::sign_out` verify parsing of present/absent tools. (Env scoping was rejected: `HOME`/`PATH` are process-global and would race the parallel suite, and `shell::path()` caches a login-shell PATH in a `OnceLock` so a stub `gpg` would not be picked up. Covered instead via path/config-taking halves — `ssh_public_keys_in`, `identity_from_config`, `helper_status_from` — plus `sign_out`'s no-subprocess error paths.)
- [x] 1.4 Add tests for `git::oauth::{client_status, set_client_id}` and `acp::cancel`, `terminal::{kill, resize}` on a not-running id; verify error kinds and no panic
- [x] 1.5 Add a `tauri::test::mock_builder`-based test in `commands/mod.rs` that invokes `watch_repo`/`unwatch_repo`, `pty_spawn`/`pty_kill`, and `cancel_provider_oauth_sign_in` against managed state; verify each returns without a runtime "command not found". (Scoped down: 22 commands take `tauri::AppHandle` = `AppHandle<Wry>`, which does not satisfy `CommandArg<MockRuntime>`, so the real `generate_handler!` list cannot compile against the mock runtime — booting it would require making the command layer generic over `R`. Covers the four state-only commands via a subset list; `watch_repo` and `pty_spawn` stay runtime-uncovered.)

## 2. Rust — command/wrapper argument-name contract

- [x] 2.1 Extend the registration test in `commands/mod.rs:40` to parse each `src/lib/api/git/<name>.ts` and `github.ts`/`providers.ts`/`terminal.ts`/`updater.ts` `invoke("<cmd>", { … })` object keys and compare (camelCase→snake_case) with the Rust parameter names; verify it fails when a parameter is renamed on one side only

## 3. Frontend — split test god-files and ratchet them

- [x] 3.1 Add a `TEST_CEILING` (e.g. 1 200 lines) for `*.test.ts(x)` to `scripts/check-file-sizes.mjs` with its own baseline; verify `bun run sizes` reports the five files listed in the proposal and nothing else
- [x] 3.2 Split `src/store/repo.test.ts` along the store's own module seams (`repoLifecycleActions`, `repoWriteActions`, `repoRefreshActions`, `repoSelectionActions`, `repoTab*`); verify `bun run test` count is unchanged and each new file is under the ceiling
- [x] 3.3 Split `menus.test.tsx`, `pulls.test.ts`, `accounts.test.ts`, `repoWriteActions.test.ts` the same way; verify `bun run sizes` passes and the baseline shrinks to `{}` for tests

## 4. CI — macOS lane and smoke e2e

- [x] 4.1 Decide the macOS runner: (a) `[self-hosted, macOS, ARM64]` with `continue-on-error: true` and a 20-minute `timeout-minutes` so an offline runner never blocks merges, or (b) GitHub-hosted `macos-14` as a required job; record the choice and its cost in `docs/rules/architecture-rules.md`; verified via `gh api repos/Siomkin/GitLane/actions/runners`: `mac-gitlane-r` is currently **offline**, which is exactly why (a) was chosen — the lane cannot block a merge. The jobs are unproven until a Mac runner is started and a run reaches them
- [x] 4.2 Add `rust-tests (macos)` and `frontend (macos)` jobs to `.github/workflows/ci.yml` per 4.1, gated by the same `TRUSTED_CI_USER` policy as `changes.outputs.runner` and skipped for untrusted PRs; the Linux jobs are unchanged (diff is additive plus one new `trusted` output). Cannot be verified on this PR: CI runs on `pull_request_target`, so the workflow comes from the base branch — these jobs only run once merged, or via `workflow_dispatch` on the branch
- [x] 4.3 Spike the smoke e2e: (a) `tauri-driver` + WebDriver on the Linux runner, or (b) a Rust integration test booting the real `generate_handler!` list via `tauri::test`; record which works (WebDriver on macOS is not verified) in `docs/rules/architecture-rules.md`; verify the chosen path opens a fixture repo, stages a file, commits, and reads the graph
- [x] 4.4 Wire the smoke test into CI behind the `rust` path filter; runs as its own step in `rust-tests` and `rust-tests-macos`, behind the `rust` filter; locally 0.53s (well under 5 minutes). Like 4.2, the step itself only executes on `latest` once merged — `pull_request_target` takes the workflow from the base branch

## 5. Definition of done

- [ ] 5.1 Run `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`, `(cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test)`, `bun run sizes`, `openspec validate raise-command-test-coverage --strict`; verify all pass on both Linux and macOS lanes
