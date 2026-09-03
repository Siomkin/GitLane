## Context

See proposal.md — Why. Specs: `ipc/commands`.

Today the boundary is `Result<T, String>` everywhere except `open_repo` (`src-tauri/src/commands/repo.rs:22` → `RepoOpenError`, `src-tauri/src/git/types/repo.rs:36-56`: `{ kind, message, path }`, serde camelCase). The `blocking()` helper (`src-tauri/src/commands/mod.rs:25-33`) is the one place 143 commands already pass through; the PR commands additionally pass through `forge_op` in `src-tauri/src/commands/github.rs`, which the `blocking_tests` module (`github.rs:271`) enforces. Classification of git stderr already exists in Rust for some cases (`git/write/cli/stable_diagnostics.rs`, `git/write/index_lock.rs`) but is discarded into a `String`; the frontend then re-classifies in `src/lib/gitError.ts` (`HOOK_HINT`, `CREDENTIAL_PROMPT_DISABLED`, `SSH_AUTH_FAILURE`, `REMOTE_UNREACHABLE`, `REMOTE_NOT_FOUND_OR_DENIED` at lines 12-35; `classifyIndexLockFailure`).

Redaction (`src-tauri/src/redact.rs`) is invoked from 14 modules (`git/write/cli/{finish,runners,stable_diagnostics}.rs`, `git/write/operands.rs`, `git/write/lifecycle/clone.rs`, `git/write/branches/deletion_transaction.rs`, `git/oauth/mod.rs`, `git/credentials.rs`, `git/read/{branches,remotes}.rs`, `git/forge/{rest,cli/command,origin/command,gitlab/transport}.rs`). A new error path that forgets it leaks.

Engine: unchanged (libgit2 reads, git CLI writes, `forge::context()` providers). Zustand store: `useRepo` refresh actions and `useNotifications`; no new store.

## Goals / Non-Goals

**Goals:**

- One serialisable boundary type, produced in one place, redacted in one place.
- Classification next to the subprocess; frontend keeps only copy/formatting.
- Silent read fallbacks become visible degraded states.

**Non-Goals:**

- Replacing internal enums (`GithubError`, `HttpError`, `CaptureError`, `LeaseError`) — they stay and convert.
- Changing success payload validation (`src/lib/api/validate.ts`); that is `harden-ipc-contract`.
- Error copy redesign.

## Decisions

### 1. Boundary type is a serde struct, not a Rust `enum` over IPC

`CommandError { kind: CommandErrorKind, message: String, detail: Option<String> }` in a new `src-tauri/src/git/types/error.rs`, `#[serde(rename_all = "camelCase")]`, `kind` as a `#[serde(rename_all = "camelCase")]` unit enum. Mirrors `RepoOpenError` exactly (copy that module; `RepoOpenErrorKind::{Missing, NotARepository, Other}` become `kind`s). Tauri serialises any `Serialize` error, so commands change their signature to `Result<T, CommandError>`.

Alternative: keep `String` and prefix a tag (`"[auth] …"`). Rejected — still stringly-typed, and the frontend would parse again.

### 2. `thiserror` for the internal enums; hand-written `Display` for the boundary

*As implemented:* derives on `HttpError`, `SecretError`, `CaptureError`, `ReaderError`; `GithubError` keeps a manual `Display` delegating to `to_ipc_string()`; `LeaseError` is untouched (message-free by design). `CommandError` is 128 bytes, so `clippy::result_large_err` is allowed in `commands/` and `git/forge.rs` rather than boxing the failure path.

Add `thiserror` (check `docs/tauri-plugin-decisions.md`: it is a proc-macro crate with no runtime/native footprint; `thiserror` 1 and 2 are already both in `Cargo.lock` transitively, so pin `2`). Internal enums get `#[derive(thiserror::Error)]` and `impl From<X> for CommandError`. Do **not** add `anyhow`: the boundary needs a closed `kind` set, and `anyhow` erases it.

### 3. Single chokepoint: `blocking()` + a `finish()` adapter

*As implemented:* `commands::blocking`, `commands::sync`, and `commands::boundary` (for the one genuinely `async` command, `check_update_on_channel`) all funnel through `boundary()`, which converts via `Into<CommandError>` and calls `CommandError::redacted()`. The registration test in `commands/mod.rs` fails any `Result` command whose body does not call one of the three, so the redaction step cannot be bypassed by construction.

`commands/mod.rs::blocking` returns `Result<T, CommandError>`; its closure may return any `Into<CommandError>`. The adapter applies `redact::redact_all` to `message` and `detail` on the way out, so per-module redaction remains defence-in-depth but is no longer load-bearing. Sync commands (24 today, e.g. `working_changes`, `list_branches`, `file_diff`) go through the same adapter via a `sync()` twin so no command bypasses it. The `forge_op` prologue in `commands/github.rs` calls the same adapter.

Alternative: a `#[tauri::command]` wrapper macro. Rejected — hides the signature from the registration-parity test in `commands/mod.rs:40`.

### 4. Classification lives where the CLI output is produced

*As implemented:* the classifier is `git/write/classify.rs` (crate-visible), invoked by `CommandError::from(String)` — so the write layer keeps returning `String` diagnostics and classification still happens in Rust, at the boundary adapter, without changing several hundred impl signatures. `finish.rs` stays the redaction/non-empty-message site.

- `git/write/cli/finish.rs` (already parses exit status + stderr): map hook rejections (`HOOK_HINT` regex moves here verbatim from `gitError.ts:12`), credential-prompt-disabled, SSH publickey, host-key, unreachable, not-found → `kind`.
- `git/write/state_lease.rs::LeaseError` → `staleLease`.
- `git/write/index_lock.rs` → `indexLock` (the frontend's `classifyIndexLockFailure` retires).
- `git/forge/domain.rs::GithubError` → `forge` / `auth`.
- Conflict detection (`git/conflicts/operation.rs`) → `conflict` when a write leaves the repo mid-operation.

Fixtures: port `src/lib/gitError.test.ts` inputs to Rust tests under `git/write/cli/tests/` so no behaviour is lost.

### 5. Frontend: typed error at the `lib/api` seam, notifications for reads

`src/lib/api/validate.ts` adds `isCommandError(e): e is CommandError` and `lib/api/index.ts` wraps `invoke` so a non-conforming rejection becomes `{ kind: "internal", message: String(e) }` — this keeps `bun run dev` (no Rust) and old tests working. `src/lib/gitError.ts` keeps `friendlyGitError` as *formatter* over `kind` + `message`. Refresh fallbacks in `repoRefreshActions.ts:121-134` change from `.catch(() => [])` to `.catch(reportSection("stashes"))` which keeps prior data, sets a per-section `unavailable` flag in `useRepo`, and pushes a notification via `useNotifications`.

## Risks / Trade-offs

- [Every command signature changes at once] → mechanical migration by module, one PR per `commands/<domain>.rs`; `commands/mod.rs` parity test plus `bunx tsc --noEmit` catch stragglers. Keep a `From<String> for CommandError` (`kind: internal`) during migration so partial states compile.
- [Double redaction cost] → `redact` is linear in message length; error messages are small.
- [Frontend regression on copy] → snapshot the current `friendlyGitError` outputs in tests before moving the regexes.
- [`thiserror` derive on `git2::Error` wrappers] → wrap, don't re-export; `git2::Error` is not `Serialize`.

## Migration Plan

1. Land `CommandError` + adapter with `From<String>` (no behaviour change).
2. Migrate `commands/*.rs` one domain at a time, moving classification into Rust as each domain's tests port.
3. Switch frontend fallbacks to notifications last; remove `From<String>` when no producer remains.
Rollback: revert the domain PR; the `From<String>` shim keeps earlier domains working.

## Open Questions

- Whether `detail` should be capped (e.g. 8 KiB) before crossing IPC — does not change specs or tasks; decide when porting `bounded_output`.
