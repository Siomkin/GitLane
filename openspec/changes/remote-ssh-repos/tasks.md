# Tasks

## 1. Spikes (gate the rest)

- [x] 1.1 S2: cross-build a minimal binary linking `git2` (vendored libgit2) and `notify` for `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`. Record the stripped size and any build blockers under "Risks" in design.md. Verify: both binaries run `--version` on a Linux host or container.
- [x] 1.2 S1: build a throwaway loopback prototype (`ssh localhost` running a stub agent) that serves `open_repo` and `commit_graph` as JSON lines. Measure the round-trip time for the graph on a 10k-commit repo and record it under D5 in design.md. Verify: the prototype returns the same JSON as the local command. The prototype code is not kept.

## 2. Headless build (Rust)

- [x] 2.1 In `src-tauri/Cargo.toml`, make `tauri`, its plugins, `keyring` and `portable-pty` optional behind a default `desktop` feature, and add an `agent` feature. Verify: `cargo check` (default) and `cargo check --no-default-features --features agent` both pass.
- [x] 2.2 Gate the desktop-only modules in `lib.rs` (`run()`, terminal, ACP, events, watcher, updater, diagnostics, signing keys, auth providers) and the commands that take `AppHandle`/`State` with `cfg(feature = "desktop")`. Gate the PTY-driven `git/forge/signin` (the only `git/` user of `events::SignInProgress`), and give `secrets::KeyringStore` a no-keychain agent impl so `git/` needs no further gates. (`log.rs` turned out to be plain `eprintln!`; S2's stub for it was unnecessary.) Note the size plan: `lib.rs` is 324 lines, so put gates on `mod` lines only, not in bodies. Verify: both `cargo check` invocations from 2.1 pass.
- [x] 2.3 Make `commands::blocking` (`commands/mod.rs:47`) use `tokio::task::spawn_blocking` when `desktop` is off. Verify: the existing `blocking` tests pass under both feature sets.
- [x] 2.4 Switch remote-capable command fns to `#[cfg_attr(feature = "desktop", tauri::command)]`. Verify: `cargo check --no-default-features --features agent` compiles `commands::*` without tauri.
- [x] 2.5 Add an agent-target build to `.github/workflows/ci.yml` (`cargo clippy --no-default-features --features agent -- -D warnings`). Verify: the CI job passes on the branch.

## 3. Command classification (Rust)

- [x] 3.1 Add the `LOCAL_ONLY` closed list in `commands/registration_tests/remote_split.rs` (test-only, like `SYNC_BY_DESIGN`). It covers terminal, ACP, auth/OAuth/keychain, credential approve/reject, github/forge, clone, reveal/open-in-editor, file-workspace writes and updater. Verify: the list compiles, and each entry is a registered handler name.
- [x] 3.2 Add the agent dispatch table macro and table under `src-tauri/src/agent/dispatch.rs`, plus the two progress commands with a `Progress` sink (D6). It deserializes camelCase args into the command fn's params and calls the same fn. Verify: unit tests call `open_repo`, `commit_graph` and `working_status` through the table against a fixture repo and match the direct call's JSON.
- [x] 3.3 Add a registration test that every `generate_handler!` command is in exactly one of the dispatch table or `LOCAL_ONLY`, and that `approve_https_credential` and `save_provider_token` are in `LOCAL_ONLY`. Verify: the test fails when an entry is removed from either list.

## 4. Agent binary and protocol (Rust)

- [ ] 4.1 Add `src/bin/gitlane-agent.rs` (`required-features = ["agent"]`): stdio JSON-lines loop, hello frame (version, protocol, git version, `$HOME`), concurrent request handling, responses tagged by request id, frames above 64 KiB compressed (D5), logs to stderr only. Verify: unit tests feed request lines and assert response frames, including out-of-order completion and a compressed round trip of a large graph frame.
- [ ] 4.2 Run the existing git version gate at agent startup, and report an old git in the hello frame as the usual unsupported-git error. Verify: test with a stubbed old git version.
- [ ] 4.3 Redact every error and stderr line on the agent with `crate::redact` before writing. Verify: a test with a token in git stderr shows it redacted in the frame.

## 5. Agent watcher (Rust)

- [ ] 5.1 Split `watcher/classification.rs` (392 lines) into the pure classification and throttle part and the `AppHandle` emit part, with no behaviour change. Verify: the existing watcher tests pass, and `bun run sizes` shows no regression.
- [ ] 5.2 Add agent `watch`/`unwatch` requests that run `notify` with the shared classifier and push `repo-changed` frames. A watch-limit failure is reported once as a notice frame. Verify: an integration test touches a file in a fixture repo and receives one throttled frame. A simulated watch failure yields one notice.

## 6. Desktop connection manager (Rust)

- [ ] 6.1 Add `src-tauri/src/remote/` with a locator parser (`ssh://[user@]host[:port]/abs/path`) that rejects relative and `~` paths. Verify: unit tests cover the alias, user, port, relative and `~` cases.
- [ ] 6.2 Add per-host sessions: spawn `ssh -T -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 <host> -- <agent> --stdio` with `crate::shell::path()`, never setting `StrictHostKeyChecking` or `-A`. Add the request-id map, a reader thread for frames, and close-on-last-tab. Verify: tests use a fake transport (stdio pipes) for multiplexing two repos and closing the last one.
- [ ] 6.3 Classify ssh failures into typed errors: interactive auth required, unknown or changed host key (naming the host), unreachable, and in-flight drop as `remoteUnavailable`. Verify: unit tests over captured ssh stderr samples.
- [ ] 6.4 Re-emit agent `repo-changed` frames through `crate::events::emit`, with the path rewritten back into the locator. Emit `remote-session-changed` on state transitions. Verify: test with the fake transport asserts the emitted payloads.
- [ ] 6.5 Skip `git/transport_auth.rs` resolution for remote locators so no `GH_TOKEN`, askpass bridge or account credential is sent. Verify: a test asserts that a forwarded push request carries no credential fields or env.

## 7. Agent delivery (Rust + release CI)

- [ ] 7.1 Detect the platform (`uname -sm`) and the installed agent version over a short `ssh` exec. Unsupported platforms fail with an error naming the platform. Verify: unit tests over sample `uname` outputs (Linux x86_64/aarch64, Darwin, FreeBSD).
- [ ] 7.2 Download `gitlane-agent-<target>` for the app version into the app-data cache, and verify it with `minisign-verify` against the updater public key. Honour the `GITLANE_AGENT_PATH` override for dev. Verify: tests with a valid signature, a tampered binary (rejected, nothing uploaded) and the override.
- [ ] 7.3 Upload through `ssh host 'mkdir -p … && cat > ….partial'`, check the size, `chmod +x`, rename atomically, then prune versions other than current and previous. Report progress through a `CloneSlot`-style slot. Verify: an integration test against `ssh localhost` (skipped when unavailable) installs, re-runs as a no-op, and prunes the third version.
- [ ] 7.4 Add musl agent build legs for both targets to `.github/workflows/release.yml` (native or cross-compiled, not emulated: S2 measured emulated x86_64 at about 11 minutes), using the size profile (`opt-level="z"`, LTO, strip), compressed, signed with the updater key and attached as release assets. Verify: a workflow dry run (`workflow_dispatch` on a non-tag ref) produces both signed assets.

## 8. IPC surface (four layers)

- [ ] 8.1 Add the `unsupportedOnRemote` and `remoteUnavailable` error kinds to the Rust error kind in `git/types/error.rs` and to `src/lib/api/git/types/error.ts`. Verify: the registration/serialization tests and the TS error tests cover both kinds.
- [ ] 8.2 Add `RemoteSessionState` and `RemoteProgress` serde types in `git/types/remote.rs`, re-exported flat, plus the `remote-session-changed` event declaration in `events.rs`. Verify: the event-name registration test passes.
- [ ] 8.3 Add `remote_invoke`, `remote_connect`, `remote_disconnect` and `list_ssh_hosts` in `commands/remote.rs`, registered in `generate_handler!` and classified. `remote_invoke` rejects non-table commands with `unsupportedOnRemote` before connecting. Verify: unit tests for the reject path and the `list_ssh_hosts` wildcard filtering.
- [ ] 8.4 Add `src/lib/api/remote.ts` with typed wrappers and schemas for the new commands and event. Verify: vitest with the inline `invoke` mock pattern.

## 9. Frontend

- [ ] 9.1 Route `invoke()` (`src/lib/api/invoke.ts`) to `remote_invoke` when the `path` or `worktreePath` arg is an `ssh://` locator. Verify: `invoke.test.ts` covers local passthrough, remote routing and error wrapping.
- [ ] 9.2 Add `isRemoteLocator` and `withLocator` to `src/lib/paths.ts`, and map server paths back to locators in the `openRepo` and worktree-list wrappers. Verify: unit tests, plus an audit (grep) of `paths.ts` callers and `isAbsolute`/basename on repo keys, with fixes covered by tests.
- [ ] 9.3 Add the leaf store `src/store/remoteSessions.ts` (per-host state and install progress, fed by `remote-session-changed`), placed below `repo.ts` in the import order. Verify: store tests, `bun run cycles` and the oxlint import-direction rule pass.
- [ ] 9.4 Add the "Open remote repository… (Beta)" dialog (ModalFrame) with host suggestions from `list_ssh_hosts`, free-text host, absolute path input and install progress. Verify: render test for suggestions, `~`/relative rejection and the progress state.
- [ ] 9.5 Add the disconnected tab state with reconnect, modelled on the GL-108 missing-repo state. Reconnect re-reads the repo. Verify: render test, and a store test that other tabs are untouched.
- [ ] 9.6 Gate the remote-unavailable features with `isRemoteLocator`: terminal, PRs tab, file editing (source view read-only), reveal, open-in-editor and ACP, each with an "unavailable for remote repositories" tooltip. Verify: render tests for each gate on a remote tab.
- [ ] 9.7 Show the one-time watch-limit notice through the notifications store, and rely on the existing focus refresh. Verify: store test.

## 10. Docs

- [ ] 10.1 Update `CLAUDE.md` (architecture map: agent, remote module, `remoteSessions` store, `desktop`/`agent` features) and `docs/rules/architecture-rules.md` (remote-capable vs `LOCAL_ONLY`, the two new error kinds). Verify: the docs name the files that exist.
- [ ] 10.2 Record the new direct dependency on `minisign-verify` in `docs/tauri-plugin-decisions.md` if that file covers Rust deps; otherwise note it in design.md. Add user docs for remote repositories (requirements, key auth, host-key step, limitations). Verify: the documented commands run as written.

## 11. Integration checks

- [ ] 11.1 End to end against `ssh localhost` and a Linux VM or container (x86_64, plus aarch64 if available): open, browse, stage, commit, rebase with a conflict, stash, fetch/pull/push with server credentials, live update from a server shell, drop and reconnect, unknown-host and password-only failures. Verify: record the results in `docs/manual-verification-backlog.md`.
- [ ] 11.2 Check that no repository files land locally: after 11.1, search app data and temp dirs for packfiles or working-tree files from the test repo. Verify: none found.
- [ ] 11.3 Run the definition-of-done suite: `bun check`, `bun run lint`, `bun run test`, `bun run build`, `cargo fmt --check`, and `cargo clippy -- -D warnings` for both feature sets, then `bun run sizes`, `bun run cycles`, and `bun run tauri dev` with a remote tab open. Verify: all pass.
