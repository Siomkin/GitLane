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

- [x] 4.1 Add `src/bin/gitlane-agent.rs` (`required-features = ["agent"]`): stdio JSON-lines loop, hello frame (version, protocol, git version, `$HOME`), concurrent request handling, responses tagged by request id, frames above 64 KiB compressed (D5), logs to stderr only. Verify: unit tests feed request lines and assert response frames, including out-of-order completion and a compressed round trip of a large graph frame.
- [x] 4.2 Run the existing git version gate at agent startup, and report an old git in the hello frame as the usual unsupported-git error. Verify: a protocol test injects a too-old gate error and checks it is carried (and redacted) in the hello frame; the gate itself is the existing `ensure_supported_git`.
- [x] 4.3 Redact every error and stderr line on the agent with `crate::redact` before writing. Verify: a test with a token in git stderr shows it redacted in the frame.

## 5. Agent watcher (Rust)

- [x] 5.1 Replace the watcher's `AppHandle` with an `OnChange` callback (`watcher.rs`), so the whole watcher (roots, linked-worktree common dir, ignore filter, throttle) compiles in both builds; the desktop's `watch_repo` emits `repo-changed` through it. This supersedes splitting `classification.rs` (now 383 lines). Verify: the existing watcher tests pass unchanged, and `bun run sizes` shows no regression.
- [x] 5.2 Serve `watch_repo`/`unwatch_repo` on the agent from one process-wide `WatcherState`, sending each change as a `repo-changed` event frame tagged with the watch request's id. A watch that cannot be installed (for example the inotify limit) returns an error response, which the desktop turns into the one-time notice (9.7). Verify: a dispatch test edits a watched file and receives `repo-changed` with the watched path; watching a missing directory returns an error.

## 6. Desktop connection manager (Rust)

- [x] 6.1 Add `src-tauri/src/remote/` with a locator parser (`ssh://[user@]host[:port]/abs/path`) that rejects relative and `~` paths. Verify: unit tests cover the alias, user, port, relative and `~` cases.
- [x] 6.2 Add per-host sessions: spawn `ssh -T -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 <host> -- <agent> --stdio` with `crate::shell::path()`, never setting `StrictHostKeyChecking` or `-A`. Add the request-id map, a reader thread for frames, and close-on-last-tab. Verify: tests use a fake transport (stdio pipes) for multiplexing two repos and closing the last one.
- [x] 6.3 Classify ssh failures into typed errors: interactive auth required, unknown or changed host key (naming the host), unreachable, and in-flight drop as `remoteUnavailable`. Verify: unit tests over captured ssh stderr samples.
- [x] 6.4 Re-emit agent `repo-changed` frames through `crate::events::emit`, with the path rewritten back into the locator. Emit `remote-session-changed` on state transitions. Verify: test with the fake transport asserts the emitted payloads.
- [x] 6.5 Skip `git/transport_auth.rs` resolution for remote locators so no `GH_TOKEN`, askpass bridge or account credential is sent. Verify: a test asserts that a forwarded push request carries no credential fields or env.

## 7. Agent delivery (Rust + release CI)

- [x] 7.1 Detect the platform (`uname -sm`) and the installed agent version over a short `ssh` exec. Unsupported platforms fail with an error naming the platform. Verify: unit tests over sample `uname` outputs (Linux x86_64/aarch64, Darwin, FreeBSD).
- [x] 7.2 Download `gitlane-agent-<target>` for the app version into the app-data cache, and verify it with `minisign-verify` against the updater public key. Honour the `GITLANE_AGENT_PATH` override for dev. Verify: tests with a valid signature, a tampered binary (rejected, nothing uploaded) and the override.
- [x] 7.3 Upload through `ssh host 'sh -c …'` (POSIX `sh`, whatever the login shell): write `.partial`, check the size, `chmod 700`, rename atomically, run `--version`, then prune every version but the current one and the newest previous one, skipping running agents. Report progress through a `Step` callback (`Downloading`/`Uploading` percent). Verify: the install and probe scripts run under a local `sh` with a temporary `$HOME` (install, prune, truncated upload); the opt-in `remote::e2e_tests` (`GITLANE_E2E_HOST`, `GITLANE_AGENT_PATH`) installs, connects, reads and watches over real ssh, and passed against an Ubuntu 26.04 x86_64 host.
- [ ] 7.4 Add musl agent build legs for both targets to `.github/workflows/release.yml` (native or cross-compiled, not emulated: S2 measured emulated x86_64 at about 11 minutes), using the size profile (`opt-level="z"`, LTO, strip), compressed, signed with the updater key and attached as release assets. Verify: a workflow dry run (`workflow_dispatch` on a non-tag ref) produces both signed assets.

## 8. IPC surface (four layers)

- [x] 8.1 Add the `unsupportedOnRemote` and `remoteUnavailable` error kinds to the Rust error kind in `git/types/error.rs` and to `src/lib/api/git/types/error.ts`. Verify: the registration/serialization tests and the TS error tests cover both kinds.
- [x] 8.2 Add `RemoteSessionState` and `RemoteProgress` serde types in `git/types/remote.rs`, re-exported flat, plus the `remote-session-changed` event declaration in `events.rs`. Verify: the event-name registration test passes.
- [x] 8.3 Add `remote_invoke`, `remote_connect`, `remote_disconnect` and `list_ssh_hosts` in `commands/remote.rs`, registered in `generate_handler!` and classified. `remote_invoke` rejects non-table commands with `unsupportedOnRemote` before connecting. Verify: unit tests for the reject path and the `list_ssh_hosts` wildcard filtering.
- [x] 8.4 Add `src/lib/api/remote.ts` with typed wrappers and schemas for the new commands and event. Verify: vitest with the inline `invoke` mock pattern.

## 9. Frontend

- [x] 9.1 Route `invoke()` (`src/lib/api/invoke.ts`) to `remote_invoke` when the `path` or `worktreePath` arg is an `ssh://` locator. Verify: `invoke.test.ts` covers local passthrough, remote routing and error wrapping.
- [x] 9.2 Add `isRemoteLocator` and `withLocator` to `src/lib/paths.ts`, and map server paths back to locators in the `openRepo` and worktree-list wrappers. Verify: unit tests, plus an audit (grep) of `paths.ts` callers and `isAbsolute`/basename on repo keys, with fixes covered by tests.
- [x] 9.3 Add the leaf store `src/store/remoteSessions.ts` (per-host state and install progress, fed by `remote-session-changed`), placed below `repo.ts` in the import order. Verify: store tests, `bun run cycles` and the oxlint import-direction rule pass.
- [x] 9.4 Add the "Open remote repository… (Beta)" dialog (ModalFrame) with host suggestions from `list_ssh_hosts`, free-text host, absolute path input and install progress. Verify: render test for suggestions, `~`/relative rejection and the progress state.
- [x] 9.5 Add the disconnected tab state with reconnect, modelled on the GL-108 missing-repo state. Reconnect re-reads the repo. Verify: render test, and a store test that other tabs are untouched.
- [x] 9.6 Gate the remote-unavailable features with `isRemoteLocator`: terminal, PRs tab, file editing (source view read-only), reveal, open-in-editor and ACP, each with an "unavailable for remote repositories" tooltip. Verify: render tests for each gate on a remote tab.
- [x] 9.7 Show the one-time watch-limit notice through the notifications store, and rely on the existing focus refresh. Verify: store test.

## 10. Docs

- [x] 10.1 Update `CLAUDE.md` (architecture map: agent, remote module, `remoteSessions` store, `desktop`/`agent` features) and `docs/rules/architecture-rules.md` (remote-capable vs `LOCAL_ONLY`, the two new error kinds). Verify: the docs name the files that exist.
- [x] 10.2 Record the new direct dependency on `minisign-verify` in `docs/tauri-plugin-decisions.md` if that file covers Rust deps; otherwise note it in design.md. Add user docs for remote repositories (requirements, key auth, host-key step, limitations). Verify: the documented commands run as written.

## 11. Integration checks

- [ ] 11.1 End to end against `ssh localhost` and a Linux VM or container (x86_64, plus aarch64 if available): open, browse, stage, commit, rebase with a conflict, stash, fetch/pull/push with server credentials, live update from a server shell, drop and reconnect, unknown-host and password-only failures. Verify: record the results in `docs/manual-verification-backlog.md`.
- [ ] 11.2 Check that no repository files land locally: after 11.1, search app data and temp dirs for packfiles or working-tree files from the test repo. Verify: none found.
- [ ] 11.3 Run the definition-of-done suite: `bun check`, `bun run lint`, `bun run test`, `bun run build`, `cargo fmt --check`, and `cargo clippy -- -D warnings` for both feature sets, then `bun run sizes`, `bun run cycles`, and `bun run tauri dev` with a remote tab open. Verify: all pass.

## 12. Usable by anyone (after the first in-app run)

- [x] 12.1 Agent: a remote with no account ref resolves to the server's own active, healthy `gh` account for its host (`transport_auth::use_server_gh`, switched on only by the agent), through the existing `TransportCredential::Gh` helper; multi-remote fetch asks the same for its unbound remotes. Verify: unit tests for the account picker (active, healthy, host match, unsafe login) and that the switch is off by default; the real `gh` path is covered by the in-app run (11.1).
- [x] 12.2 Make `repo_forge` remote-capable, drop the frontend `null` short-cut, and gate PR loading on `isRemoteLocator`. Show the provider and its link in the SSH host chip. Verify: store test that a remote repo with a GitHub forge loads no pull requests; render test for the link.
- [x] 12.3 Plain-language error when the server has no credentials (names the server and the remote host, no local-account action, a "How to set this up" link to the docs guide). Verify: `gitError` tests.
- [x] 12.4 Askpass bridge: drop `BatchMode=yes`, set `SSH_ASKPASS`/`SSH_ASKPASS_REQUIRE=force`, re-enter the binary as the askpass helper, carry prompts over a nonce-guarded loopback listener, emit `ssh-prompt`, answer through `answer_ssh_prompt` (added to the secret-command list and its audit test), pause the hello watchdog while a prompt is open. Verify: unit tests for prompt classification, answer replay and the listener (nonce, round trip); a harness ran macOS OpenSSH 10.5 against the Ubuntu host with an empty known-hosts file and the built binary as askpass, and the host-key question arrived, "yes" recorded the key and the session connected. The password path is left to the in-app run (11.1).
- [x] 12.5 SSH prompt dialog mounted with the global overlays: secret input for passwords/passphrases, fingerprint with Trust/Cancel for an unknown host key. Verify: render tests, including during the restoring shell view.
- [x] 12.6 `list_directory` (four IPC layers, remote-capable) and the folder browser step of the open dialog, rooted at the server's home. It lists sub-folders only (a repository is always a folder). Verify: Rust test over a temp dir (repo, plain dir, unreadable dir, dot-dir, file); render test for browsing and opening.
- [x] 12.7 Host form: host, user and port fields; suggestions from SSH config and recent remote origins. Verify: render test that picking a recent host fills all three fields.
- [x] 12.8 Update CLAUDE.md, `architecture-rules.md` (three secret commands), and the docs-site guide (prompts, host trust, browsing, gh on the server). Verify: the docs name files that exist.

## 13. Saved SSH connections (after the reference review)

- [x] 13.1 Rust: `remote/connections.rs` store (app-data JSON, managed state, one connection per origin via `Locator`), `list/save/delete_ssh_connection` (local-only, four layers), key path validation and `~/` expansion. Verify: unit tests for validation, the duplicate-origin refusal and the file round trip.
- [x] 13.2 Rust: carry the key through the per-origin connect context as `-i <path> -o IdentitiesOnly=yes`; `connect_to` resolves it from the store, `remote_connect` takes an explicit override for Test. A key file that doesn't exist is refused (ssh would only warn and fall back to other keys). Verify: `ssh_command` arg test; against the Ubuntu host, `-i <key> -o IdentitiesOnly=yes` connected, and a missing key file showed the fallback this guards against.
- [x] 13.3 Connection form (name, host, port, key file, Test) shared by the open dialog and Settings; the open dialog's host picker lists saved connections, SSH config hosts and "Add SSH connection…"; closing without opening disconnects an otherwise unused session. Verify: render tests for add, test-then-cancel and picking a saved connection.
- [x] 13.4 Settings → SSH connections: list, edit, remove, add. Verify: render test.
- [x] 13.5 Tabs and the toolbar chip show a saved connection's name for its origin. Verify: render tests.

## 14. Terminal on the server (follow-up)

- [ ] 14.1 For a remote tab, the integrated terminal runs `ssh -t <destination>` (with the saved connection's key) in its PTY and starts a login shell in the repository's folder on the server, instead of being disabled. Sign-in questions appear in the terminal itself. Needs its own spec delta (it reverses "terminal disabled for remote repositories") before building.

