## Why

The IPC surface is 181 registered commands (`src-tauri/src/lib.rs:129-311`) plus 9 backend→frontend events, and the parts of that contract that the compiler cannot check are drifting: event names are string literals duplicated on both sides with no shared constant, two Rust event payload structs have no TypeScript twin, only three of the 21 `lib/api` wrapper modules validate responses with the existing zod seam, 12 libgit2 read commands run synchronously on the webview main thread, four `OnceLock` tool-availability caches never refresh for the life of the process, and one command (`list_repo_files`) returns an unbounded list. Two commands receive user-entered secrets while `CLAUDE.md` and `openspec/config.yaml` document only one. This change makes those invariants explicit and enforceable.

No Jira key (GL-xx) for this change. Touches Rust (`commands/`, `watcher`, `git/status`), IPC (events, types), and the frontend (`lib/api`, event hooks).

## What Changes

- **Events become a typed, single-source contract.** Names today: `repo-changed` (`src-tauri/src/watcher/classification.rs:93` ↔ `src/hooks/useRepoWatcher.ts:63`), `pty-data`/`pty-exit` (`terminal.rs:178,192` ↔ `src/features/terminal/panes/usePtyEvents.ts:19,22`), `clone-progress` (`commands/repo.rs:111` ↔ `useCloneFlow.ts:96`), `acp-progress` (`commands/terminal.rs:144` ↔ `src/features/changes/agentRun.ts:68`), `handoff-progress` / `delete-worktree-progress` (`commands/worktrees.rs:68,100` ↔ `useHandoffRun.ts:75`, `useDeleteWorktreeRun.ts:119`), `github-signin-progress` (`git/forge/signin/slot.rs:47` ↔ `useGithubSigninRun.ts:120`), `provider-oauth-progress` (`git/oauth/mod.rs:355` ↔ `useProviderOauthRun.ts:136`). Every emit is `let _ = app.emit(…)` (9 sites, failures dropped by design). `HandoffProgressEvent` and `DeleteWorktreeProgressEvent` exist only in Rust; TS listens with an inline `{ step: string }`.
- **Every command response is validated at the `lib/api` seam.** `src/lib/api/validate.ts` + `schemas.ts` already do this for graph, history search, working changes, file diff, PR and account payloads, but only `github.ts`, `git/status.ts`, `git/repo.ts` call `parse`; the other wrappers trust `invoke<T>`.
- **Reads that can be slow leave the main thread.** 24 commands are sync; the libgit2 ones — `open_repo`, `list_branches`, `working_changes`, `file_diff`, `commit_files`, `commit_file_diff`, `diff_range`, `diff_range_file`, `list_remotes`, `repo_forge`, `repo_identity`, `default_git_identity` — block the webview until they return. `working_changes` additionally probes PATH for `git-lfs` (`src-tauri/src/git/status/advanced.rs:188`), mitigated only by the startup warm-up at `lib.rs:58-60`. `reveal_path` (`commands/repo.rs:157` → `shell.rs:201-228`) spawns `open`/`explorer`/`xdg-open` synchronously (non-blocking `spawn()`, but on the main thread).
- **Tool caches are refreshable.** `GIT_VERSION_CHECK` (`git/write/cli/version.rs:8`), `GH_CAPABILITIES` (`git/forge/cli/capabilities.rs:13`), `GLAB_PRESENT` (`git/forge/gitlab/transport.rs:80`), `ORIGIN_CAPABILITIES` (`git/forge/origin/capabilities.rs:6`) are `OnceLock`s: installing or upgrading `git`/`gh`/`glab`/`origin` during a session is not seen until restart.
- **List/blob payloads are bounded and declared.** Bounded today: graph 2000 rows/page (`commands/repo.rs:19`, `src/store/repoTypes/data.ts:33-34`), text 2 MiB (`git/status/files.rs:20`), blob preview 8 MiB base64 (`git/status/blob.rs:18` — about 10.7 MB of JSON string per call), history 500 / blame 10 000 (`git/status/history.rs:13,16`), forge CLI output via `bounded_output`. Unbounded: `list_repo_files` (`git/status/files.rs:31` → `Vec<String>`).
- **Both secret-bearing commands are named and constrained.** `approve_https_credential(password)` and `save_provider_token(token)` (`src-tauri/src/commands/auth.rs`) each receive a user-entered secret once; docs currently claim a single path (`CLAUDE.md` "The only accepted secret IPC path", `openspec/config.yaml` context).
- **Ordering with `unify-error-model`:** that change also edits `commands/mod.rs::blocking` and the registration test (`commands/mod.rs:40`) and adds the first `ADDED` requirements to `ipc/commands`. Archive it first; this change's `blocking()`/test edits are rebased on the `CommandError` version. The `## Purpose` in this delta duplicates that one verbatim so archive order cannot leave a placeholder.
- **Command surface consolidation (design/tasks only, no behaviour change):** three get/set/reset settings triplets (`commands/terminal.rs:15-53,70-82`: `terminal_agents_*`, `acp_agents_*`, `commit_agent_messages_*` = 9 commands over 3 JSON files); singular/plural pairs `cherry_pick`/`cherry_pick_many`, `revert_commit`/`revert_many`, `stage_file`/`stage_files`, `unstage_file`/`unstage_files` (each singular has exactly one caller); `updater::check_update_on_channel` living outside `commands/` (`src-tauri/src/updater.rs:73`, registered `lib.rs:288`) against GL-360.

Verified and **not** changed: no command is dead (181 registered = 181 invoked from `src/lib/api`), no `invoke()` outside `src/lib/api` (eslint rule, `eslint.config.js:105`), registration parity is test-enforced (`commands/mod.rs:40`), no lock is held across an `.await` (all subprocess work runs inside `blocking()`; heuristic scan found none), `.lock().unwrap()` appears only in the OAuth test double (`git/oauth/http/testing.rs:45,57`), all five `tauri::State` slots (`lib.rs:44-48`) are `Arc<Mutex<_>>` behind accessor fns, every `listen()` has a matching unlisten (`src/hooks/useStepRun.ts:57-60`, `agentRun.ts:66-79`, `usePtyEvents.ts:42-43`).

## Capabilities

### New Capabilities

- `ipc/commands`: the cross-cutting command/event contract — typed events, validated responses, responsiveness of reads, cache refresh, payload bounds, and the enumerated secret paths. (Sibling delta to `unify-error-model`; distinct requirements.)

### Modified Capabilities

- None. There is no main spec for `ipc/commands` yet.

## Impact

- Rust: new `src-tauri/src/events.rs` (names + payload structs, serde camelCase) used by the 9 emit sites; `commands/repo.rs`, `commands/status.rs`, `commands/branches.rs` (async + `blocking()` for the 12 reads); `git/status/files.rs` (bounded `list_repo_files`); the four `OnceLock` sites become `RwLock<Option<_>>` with an explicit `refresh_tool_probes` command or a TTL; `commands/updater.rs` (move).
- TS: `src/lib/api/events.ts` (names + payload types + typed `listen` helper), `schemas.ts` (add schemas for the remaining response shapes), every `git/<name>.ts` wrapper calls `parse`.
- Docs: `CLAUDE.md` and `openspec/config.yaml` context to say "two secret-bearing commands".
- Tests: event-name parity test (Rust constant ↔ TS constant), schema coverage test (every wrapper `invoke` has a schema), `commands/github.rs:271`-style async guard extended to the read commands listed above.
- Secrets/auth/IPC risk: no new secret path; `save_provider_token` and `approve_https_credential` keep piping straight to keychain / `git credential approve`. Tokens never enter JS/Zustand (verified: `src/store/accounts/credentials.ts:53-65` takes the token as an action argument only).

## Non-goals

- Changing the read/write engine split or moving layout math to JS.
- Streaming/pagination for `commit_graph` beyond the existing 2000-row paging.
- Replacing Tauri events with a different transport.
- Removing the `preview_*` command family (7 commands) — they are a deliberate two-phase pattern for destructive ops.
