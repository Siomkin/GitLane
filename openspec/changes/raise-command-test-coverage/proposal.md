## Why

The suite is large (284 frontend test files, 141 Rust test files, 1 079 `#[test]` functions) but has three structural holes the audit surfaced: (1) 41 of 181 commands have no test that references the command name, and after resolving each to the function it delegates to, 22 (18 named implementation functions plus 4 state-bound commands) have no Rust test reference at all; (2) CI runs every test only on Linux (`.github/workflows/ci.yml` jobs `frontend` and `rust-tests (linux)`, lines 189-299; zero `macos`/`windows` matches) for an app whose primary platform is macOS, so `#[cfg(target_os = "macos")]` code (`lib.rs:73-125` menu, `shell.rs:203-207`, `keyring` apple-native) never executes in CI; (3) there is no end-to-end test of any kind (no `tauri-driver`, `playwright`, or `webdriverio` in `package.json` or workflows), so the IPC contract is exercised only by mocks (`vi.mock('@tauri-apps/api/core')`) and by hand.

No Jira key (GL-xx) for this change. Touches tests and CI only (Rust test modules, vitest files, `ci.yml`). `skip_specs: true` — test and CI additions change no observable behaviour.

## What Changes

- **Command-level coverage for the 22 uncovered commands (18 implementation functions + 4 state-bound)** (resolved from `src-tauri/src/commands/*.rs` one-line bodies; zero references in any `tests/`, `tests.rs`, or inline `#[cfg(test)]` module):
  `acp_agents::{reset, save}`, `acp::cancel`, `terminal_agents::{load_messages, save_messages, reset_messages_to_defaults, reset_to_defaults, save}`, `git::credentials::helper_status`, `git::read::default_identity`, `auth_providers::sign_out`, `signing_keys::list`, `git::oauth::{client_status, set_client_id}`, `terminal::{kill, resize}`, `git::write::branches::rename_branch`, `git::write::staging::stage_all`, plus the state-bound commands `provider_oauth_sign_in`, `pty_spawn`, `watch_repo`, `unwatch_repo` (delegate to `tauri::State` accessors; not resolvable by name).
- **Command modules themselves are untested** except two meta-tests: registration parity (`src-tauri/src/commands/mod.rs:40`) and the PR-command async guard (`commands/github.rs:271`). Add a contract test per `commands/<domain>.rs` that each command's Rust signature matches the TS wrapper's argument names (the snake_case ↔ camelCase mapping, `CLAUDE.md` "Tauri arg-name convention") — today an arg rename compiles on both sides and fails only at runtime.
- **CI runs the suites on macOS.** A self-hosted macOS ARM64 runner label exists for releases (`release.yml:41`, `[self-hosted, macOS, ARM64]`), but those runners are started by hand for a release and are not always-on, so a *required* job on that label would queue between releases. Add a `rust-tests (macos)` + `frontend (macos)` lane for pushes to `latest` and trusted PRs that is either non-required (`continue-on-error`) on the self-hosted label, or runs on GitHub-hosted `macos-14` (billed minutes) — the choice is a task. Linux stays the untrusted-PR fallback.
- **One smoke end-to-end path.** Launch the built app against a fixture repository, open it, stage a file, commit, and read the graph — through the real IPC, not mocks. Tooling choice (tauri-driver/WebDriver on Linux, or a Rust integration test that boots `tauri::test::mock_builder` with the real handler list) is a task; WebDriver support on macOS is **not verified**.
- **Test god-files are split.** Co-located tests are excluded from the size ratchet (`scripts/check-file-sizes.mjs:32`), so `src/store/repo.test.ts` (5 120 lines, 60 commits in 73 days), `src/components/chrome/overlays/menus.test.tsx` (1 990), `src/store/pulls.test.ts` (1 964), `src/store/accounts.test.ts` (1 441), `src/store/repoWriteActions.test.ts` (1 384) are the repository's highest churn × size hotspots. Add a separate, higher ceiling for `*.test.*` to the ratchet and split those five along the same seams as their subjects.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- None. `skip_specs: true` — tests and CI only.

## Impact

- Rust: new tests under `src-tauri/src/{acp_agents,terminal_agents,signing_keys,auth_providers}.rs` inline modules, `git/write/tests/{branches,staging}/`, `git/oauth/tests`, `git/credentials.rs`; `commands/mod.rs` contract test reading `src/lib/api/git/*.ts`.
- Frontend: split of the five test files; `scripts/check-file-sizes.mjs` + `scripts/file-size-baseline.json` for the test ceiling.
- CI: `.github/workflows/ci.yml` new macOS lane using the existing runner labels; `docs/rules/architecture-rules.md` definition-of-done note.
- No IPC, no secrets, no behaviour change.

## Non-goals

- 100 % line coverage or a coverage gate.
- Windows CI (no Windows runner exists; release builds cross-compile on GitHub-hosted Windows only).
- Rewriting the mock-`invoke` pattern (`src/test/README.md`) — it stays the unit-test seam.
