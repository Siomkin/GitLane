## Why

All 181 registered Tauri commands (`src-tauri/src/lib.rs:129-311`) return `Result<_, String>` except `open_repo` → `RepoOpenError` (`src-tauri/src/commands/repo.rs:22`), so the frontend re-derives every error category by regex over raw `git`/`gh` text (`src/lib/gitError.ts:106` `friendlyGitError`, 278 lines, 31 string tests). Secret redaction is applied module by module (14 call sites) instead of once at the boundary, and 48 frontend `.catch(() => <literal>)` sites turn failed reads into empty lists with no signal to the user. This audit change replaces the stringly-typed boundary with one structured error contract.

No Jira key (GL-xx) for this change. Touches Rust (error types + boundary), IPC (error payload), and the frontend (`lib/api`, stores, `gitError.ts`).

## What Changes

- **BREAKING (internal IPC)**: every command's error payload becomes a serialised `CommandError { kind, message, detail? }` instead of a bare string. `RepoOpenError` (`src-tauri/src/git/types/repo.rs:36-56`) is the in-tree precedent and is folded in as one `kind`.
- The seven ad-hoc Rust error representations collapse onto one boundary type: `String` (everywhere), `RepoOpenError` (`types/repo.rs:36`), `GithubError` (`git/forge/domain.rs:39`), `HttpError` (`git/oauth/http/types.rs:19`), `CaptureError` / `ReaderError` (`git/forge/bounded_output/error.rs:8,53`), `LeaseError` (`git/write/state_lease.rs:44`), `SecretError(String)` (`secrets.rs:107`). Internal enums stay; each gains a `From` into the boundary type.
- Error *classification* (hook rejection, auth failure, network, stale lease, stranded `index.lock`, conflict) moves into Rust where the CLI output is produced. `src/lib/gitError.ts` shrinks to presentation only.
- Secret redaction (`src-tauri/src/redact.rs`) runs once, at the boundary, for every error, in addition to the existing per-module calls.
- Frontend read-fallbacks that currently hide failures (`src/store/repoRefreshActions.ts:121-134` map worktrees/stashes → `[]`, forge/operation status → `null`; `src/store/repoRefresh/worktreeScope.ts:39`; `src/store/repoWriteActions/shared.ts:309`) MUST surface a non-blocking notification instead of rendering the section as empty.
- No `thiserror`/`anyhow` today (`src-tauri/Cargo.toml` has neither). Adding `thiserror` is a design decision, not a requirement.

## Capabilities

### New Capabilities

- `ipc/commands`: the cross-cutting command contract — how a command failure crosses IPC (structured kind + redacted message), where classification happens, and how the frontend surfaces failed reads.

### Modified Capabilities

- None. There is no main spec for `ipc/commands` yet.

## Impact

- Rust: new `src-tauri/src/git/types/error.rs` (serde, camelCase) + `commands/mod.rs::blocking` (`src-tauri/src/commands/mod.rs:25-33`, which today stringifies join errors as `"git task failed: …"`); `git/write/cli/finish.rs` and `cli/stable_diagnostics.rs` (where `git` stderr is already parsed and redacted); `forge_op` prologue (`src-tauri/src/commands/github.rs`; the `forge::ipc` helpers it imports are declared inside `git/forge.rs` — exact location not verified) which is the existing single chokepoint for PR commands.
- Ordering with `harden-ipc-contract`: both changes edit `commands/mod.rs::blocking` and the registration test at `commands/mod.rs:40`, and both add `ADDED` requirements to `ipc/commands`. Land and archive this change first; `harden-ipc-contract` then rebases its `blocking()`/test edits on the `CommandError` version.
- Conversion sites to migrate (counts, non-test): 47 `map_err(|e| e.to_string())`, 86 `map_err(|e| format!(`, 125 `Err(format!(`, 111 `Err("…".into())`.
- TS: `src/lib/api/validate.ts` (already throws `IpcValidationError` for malformed *success* payloads) gains the error side; `src/lib/gitError.ts`; every store `catch` that inspects error text (`src/store/repoConflictActions.ts`, `src/store/repoLifecycleActions.ts`, `src/lib/stashOutcome.ts` — candidates, not individually verified); `src/store/notifications.ts` for surfaced read failures.
- Tests: `src/lib/gitError.test.ts` regex fixtures become Rust classifier fixtures; store tests asserting `[]` on failure flip to asserting a notification.
- Secrets/auth/IPC risk: the boundary type carries the same redacted text as today; classification never echoes credential values. No new secret path.

## Non-goals

- Changing which git engine performs any operation (libgit2 reads, CLI writes stay).
- Retry/backoff policy changes for auto-fetch (`src/hooks/useAutoFetch.ts:43`).
- Localising error copy.
- Rewriting the 48 fire-and-forget `.catch(() => {})` sites that guard window-chrome and cancel calls (`src/components/chrome/WindowControls.tsx`, `paneController.ts`, `acpCancel` callers) — those are legitimately best-effort and stay.
