## 1. Events (Rust impl + types)

- [x] 1.1 Create `src-tauri/src/events.rs` with name constants and serde camelCase payload structs moved from `watcher/classification.rs`, `terminal.rs`, `commands/{repo,terminal,worktrees}.rs`, `git/forge/signin/slot.rs`, `git/oauth/mod.rs`; replace the 9 literal emits; verify `cargo test` and a grep shows no `emit("` literal outside `events.rs`
- [x] 1.2 Create `src/lib/api/events.ts` with matching names, payload types, and `listenTyped`; migrate the 8 `listen()` sites (`useRepoWatcher.ts:63`, `usePtyEvents.ts:19,22`, `useCloneFlow.ts:96`, `agentRun.ts:68`, `useHandoffRun.ts:75`, `useDeleteWorktreeRun.ts:119`, `useGithubSigninRun.ts:120`, `useProviderOauthRun.ts:136`); verify `grep -rn 'listen(' src | grep -v events.ts | grep -v test` is empty
- [x] 1.3 Add a Rust test that parses `src/lib/api/events.ts` and asserts name-set equality with `events.rs` (same technique as `commands/mod.rs:40`); verify it fails when one side is edited

## 2. Response validation (TS api)

- [x] 2.1 Split `src/lib/api/schemas.ts` into `src/lib/api/schemas/<domain>.ts` mirroring `git/types/`; remove the ratchet exemption at `scripts/check-file-sizes.mjs:20`; verify `bun run sizes` passes
- [x] 2.2 Add zod schemas + `satisfies` guards for every response type in `git/types/{refs,worktree,conflicts,files,preview,auth,status}.ts`, `providers.ts`, `terminal.ts`, `updater.ts`; call `parse` in each wrapper; verify a test enumerates `invoke(` call sites in `src/lib/api` and asserts each passes through `parse` (allow-list void-returning commands)
- [x] 2.3 Verify `bun run test` for `src/lib/api/**` and that `IpcValidationError` surfaces through the GL-56 error boundaries in one manual malformed-payload test

## 3. Thread placement (Rust command + handler)

- [x] 3.1 Convert `open_repo`, `list_branches`, `working_changes`, `file_diff`, `commit_files`, `commit_file_diff`, `diff_range`, `diff_range_file`, `list_remotes`, `repo_forge`, `repo_identity`, `default_git_identity`, `reveal_path` to `async fn` + `blocking()` (copy `commit_graph`, `commands/repo.rs:30-35`); verify `cargo clippy` and existing tests
- [x] 3.2 Extend the registration test in `commands/mod.rs` with an all-commands-async check and a `SYNC_BY_DESIGN` allow-list (`cancel_clone`, `cancel_github_sign_in`, `cancel_provider_oauth_sign_in`, `pty_write`, `pty_resize`, `pty_kill`, `commit_agent_messages_get/set/reset`, `terminal_agents_set`); verify it fails when a new sync command is added
- [ ] 3.3 Verify in `bun run tauri dev` on a 50k-file repository that the toolbar spinner keeps animating during the first status read

## 4. Tool-probe caches (Rust impl + command + TS api)

- [x] 4.1 Replace `GIT_VERSION_CHECK` (`git/write/cli/version.rs:8`), `GH_CAPABILITIES` (`git/forge/cli/capabilities.rs:13`), `GLAB_PRESENT` (`git/forge/gitlab/transport.rs:80`), `ORIGIN_CAPABILITIES` (`git/forge/origin/capabilities.rs:6`) with a `ToolProbes` state (`RwLock<Option<_>>` each) managed in `lib.rs`; verify unit tests for probe → invalidate → re-probe
  - Deviation: `ToolProbes` is a process-wide `static TOOL_PROBES` in `src-tauri/src/git/tool_probes.rs`, not `tauri::State` — the probes are read from deep inside the write layer and the forge providers, which have no `AppHandle`. Every cell caches only a *success*. Hot path unchanged: one probe per invalidation.
- [x] 4.2 Add `refresh_tool_probes` (`commands/auth.rs` + `generate_handler!` + `src/lib/api/providers.ts`); invalidate on `NotFound` spawn errors; verify the registration-parity test and a wrapper test
- [x] 4.3 Call the refresh from account add/remove, settings save, and the PR-list retry affordance in `useAccounts`/`usePulls`; verify a store test and the "install gh after launch" scenario manually (manual scenario not exercised)
  - "Settings save" has no single action in this frontend (settings write immediately); the Accounts-panel mutations (GitHub sign-in/out, provider token save/sign-out, OAuth sign-in) and its explicit Refresh (`loadForgeAuth(true)`) are treated as that surface. The PR-list retry is the panel's Refresh button (`refreshPullRequests`).

## 5. Payload bounds (Rust impl + types + TS api + UI)

- [x] 5.1 Bound `list_repo_files` (`git/status/files.rs:31`) to `{ paths, truncated }` with a 50 000 cap; update `git/types/files.rs`, `src/lib/api/git/types/files.ts`, `git/files.ts` wrapper, and the FilesPanel partial badge; verify a Rust test at cap+1 and a component test for the badge
- [x] 5.2 Add a table of every list/blob bound to `docs/rules/architecture-rules-rust.md` (graph 2000, text 2 MiB, blob 8 MiB, history 500, blame 10 000, files 50 000, forge output via `bounded_output`); verify the doc lists each constant's file

## 6. Secret paths and docs

- [x] 6.1 Add `SECRET_BEARING_COMMANDS` to the `commands/mod.rs` test and fail on any other command parameter named `password`/`token`/`secret`; verify it passes today with exactly `approve_https_credential` and `save_provider_token`
- [x] 6.2 Update `CLAUDE.md` ("Read/write split", "GitHub / multi-account model") and `openspec/config.yaml` context to name both secret-bearing commands; verify the wording matches the spec requirement

## 7. Consolidation (Rust command + TS api)

- [x] 7.1 Move `check_update_on_channel` from `src-tauri/src/updater.rs:73` into `src-tauri/src/commands/updater.rs`, keeping `updater.rs` as impl; verify `generate_handler!` path and the endpoint tests still pass
- [x] 7.2 Retire `cherry_pick`, `revert_commit`, `stage_file`, `unstage_file` after moving their single callers to the `_many`/`_files` forms; verify `bunx tsc --noEmit`, store tests, and the parity test
- [x] 7.3 Decide (and record here) whether to fold the three settings triplets into one `settings_{get,set,reset}(kind)` trio; if yes implement with unchanged on-disk JSON; verify `terminal_agents`/`acp_agents` tests still pass
  - Decision (2026-09-03): **keep the three settings triplets as they are.** A `settings_{get,set,reset}(kind)` trio would need an enum-tagged union payload, and task 2.2 is adding a zod schema per response type — a tagged union there is strictly harder to validate and to type than three flat wrappers, which is exactly the "makes `acp_agents` validation worse" tie-breaker in design.md Decision 7. Nine tiny commands cost nothing at runtime; the parity tests already guard their registration. No code change for 7.3.

## 8. Definition of done

- [ ] 8.1 Run `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`, `(cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test)`, `bun run sizes`, `openspec validate harden-ipc-contract --strict`; verify all pass
- [ ] 8.2 Exercise in `bun run tauri dev`: clone with progress, hand-off between worktrees, PTY session, GitHub sign-in; verify each progress checklist still ticks through `listenTyped`
