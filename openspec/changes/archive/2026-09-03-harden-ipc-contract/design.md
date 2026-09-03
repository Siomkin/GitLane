## Context

See proposal.md for the inventory. Specs: `ipc/commands` (this change adds requirements alongside `unify-error-model`; both are `ADDED`, distinct names, and merge into the same main spec at archive).

The four-layer IPC contract (impl, command + `generate_handler!`, serde types, TS wrapper) already has one compiler-blind gap closed by a test (`src-tauri/src/commands/mod.rs:40` registration parity). Events and response shapes have no such guard. Engine: unchanged. Zustand stores: `useRepo` (file panel truncation flag), `useAccounts` (retry triggers re-probe); no new store.

## Goals / Non-Goals

**Goals:** make events, response shapes, thread placement, cache lifetime, payload bounds, and secret paths test-enforced properties of the boundary.

**Non-Goals:** transport changes; a codegen step (e.g. `specta`/`tauri-specta`) — see Decision 2.

## Decisions

### 1. Events: one Rust module, one TS module, parity test

`src-tauri/src/events.rs` declares `pub const REPO_CHANGED: &str = "repo-changed"` etc. plus the payload structs (move `RepoChangedEvent`, `PtyDataEvent`, `PtyExitEvent`, `CloneProgress`, `HandoffProgressEvent`, `DeleteWorktreeProgressEvent`, the ACP/sign-in/OAuth progress structs here; serde camelCase). `src/lib/api/events.ts` declares the same names and TS types, and exports `listenTyped(name, schema, handler)` built on `@tauri-apps/api/event.listen` + `validate.parse`. A Rust test reads `src/lib/api/events.ts` (same technique as `commands/mod.rs` reading `lib.rs`) and asserts the name sets are equal.

Alternative: keep literals, add a lint. Rejected — a lint cannot see both sides.

### 2. Response validation: extend the existing zod seam, no codegen

`schemas.ts` already pairs a zod schema with a compile-time `satisfies` guard for the hand-written interface. Add schemas for the remaining response types (refs, worktrees, stashes, conflicts, files, preview, auth/provider statuses, terminal/ACP catalogues) and call `parse` in every `git/<name>.ts` wrapper. `schemas.ts` (418 lines) is exempt from the size ratchet (`scripts/check-file-sizes.mjs:20`); split it per domain under `src/lib/api/schemas/` mirroring `git/types/`.

Alternative: `tauri-specta` to generate TS from Rust. Rejected for now: adds a build-time dependency (`docs/tauri-plugin-decisions.md` applies) and would replace the hand-written interfaces the whole frontend imports; revisit if schema drift keeps recurring.

### 3. Slow reads: `async fn` + `blocking()`, guarded by test

Convert the 12 libgit2 reads to `pub async fn … { blocking(move || …).await }` exactly like `commit_graph` (`commands/repo.rs:30-35`). `Repository` is opened and dropped inside the closure (not `Send`, per `CLAUDE.md`). Extend the `blocking_tests` idea from `commands/github.rs:271` into `commands/mod.rs`: every `#[tauri::command]` must be `async` unless listed in `SYNC_BY_DESIGN` (`cancel_*`, `pty_write`, `pty_resize`, `pty_kill`, `commit_agent_messages_get`, `terminal_agents_set` — instant lock-or-file ops). `reveal_path` joins the async set.

Trade-off: an extra thread hop (~µs) on tiny repos; acceptable.

### 4. Tool caches: `RwLock<Option<Probe>>` + explicit invalidation

Replace the four `OnceLock`s with a `ToolProbes` struct in `tauri::State` holding `RwLock<Option<_>>` per tool, invalidated by a new `refresh_tool_probes` command (called by the frontend on account changes, settings save, and the "Retry" affordance) and by any `NotFound` spawn error. Git version check keeps its fast path (probe once per invalidation).

Alternative: TTL. Rejected — a fixed TTL both re-probes needlessly and still leaves a window after install.

### 5. Bound `list_repo_files`

Return `{ paths: Vec<String>, truncated: bool }` with a 50 000-path cap (constant next to `MAX_TEXT_BYTES` in `git/status/files.rs:20`); `FilesPanel` shows a "partial" badge and keeps `suggest_tree_paths` (already `limit`-bounded) as the search path.

### 6. Secret paths: documented + audited

Add `SECRET_BEARING_COMMANDS = ["approve_https_credential", "save_provider_token"]` to the registration test and fail if any other command has a parameter named `password`, `token`, or `secret`. Update `CLAUDE.md` and `openspec/config.yaml` to name both.

### 7. Consolidation (mechanical)

- Settings triplets → one `settings_get/set/reset(kind: SettingsKind)` trio (3 commands instead of 9) with an enum-tagged payload; or leave as-is if the enum payload makes `acp_agents` validation worse — decide during apply, record in tasks.
- Drop the singular commands whose plural exists (`cherry_pick`, `revert_commit`, `stage_file`, `unstage_file`) after moving the single caller to the plural.
- Move `check_update_on_channel` into `commands/updater.rs` (GL-360).

## Risks / Trade-offs

- [Schema coverage doubles `schemas.ts` size] → split per domain (Decision 2).
- [Async reads change store timing in tests] → the wrappers already return promises; no store change.
- [Consolidating settings commands touches persisted JSON shape] → keep on-disk format; only the command surface changes.
- [Cache invalidation on every `NotFound`] → bounded to one re-probe per failure.

## Open Questions

- ~~Whether `listenTyped` should also enforce an unlisten-on-unmount contract via a hook~~ — decided: `listenTyped` is a plain function returning `Promise<UnlistenFn>` exactly like `listen`; the existing call sites already own their unlisten lifecycle (effects, run-scoped promises) and a hook would not fit the non-React callers (`agentRun.ts`).
