# Proposal

## Why

The IPC and write boundary still passes several closed sets of values around as free
strings. The receiving side parses them again, and its fallbacks differ from site to site.
The 2026-09-25 audit found the consequences:

- An unknown PR state action **closes** a GitHub PR, because `set_pr_state_args` has a
  `_ => "close"` fallback.
- The reset preview turns an unknown mode into "mixed", which the write then rejects.
- Most leased writes fail as `kind: git` instead of `staleLease`, because their wording
  misses `STALE_LEASE_MARKERS`.
- Every libgit2 `Os` error becomes `missingPath`, so a permission error opens the
  "repository missing" screen.
- Most reads stringify `git2::Error`, so the typed kinds never reach the UI.
- `fetch` skips remotes by substring-matching another module's error text.
- The frontend copies Rust's transport regexes (`gitError.ts`) and classifies
  `repo_file_text` failures by regex.

The `ipc/commands` spec already requires classification to happen in the backend. This
change makes the code meet it. No Jira issue exists yet.

## What Changes

- Serde enums at the command boundary: `MergeMethod { Merge, Squash, Rebase }`,
  `PrStateAction { Close, Reopen, Ready }`, `ResetMode` (already exists; the preview uses
  it), and `OperationKind` (gains `Deserialize` and `subcommand()`). An unknown value is a
  deserialize error. No provider or write falls back to a default.
- libgit2 errors keep their category. The `.map_err(|e| e.to_string())` calls in
  `commands/{conflicts,files,identity,repo,status}.rs` go away, and `ErrorClass::Os` maps to
  `internal` (the frontend's existing `openRepo` re-probe decides whether the path is gone).
- Every leased write ends its stale message through one `stale(msg)` helper in
  `write/classify.rs`, so all of them arrive as `staleLease`. A test fails if any lease
  message in `write/` bypasses the helper.
- Typed errors replace substring control flow. `credential_for_remote` returns a typed
  "remote has no URL" result. The worktree-removal lease `capture` returns
  `Stale | Other`. `CaptureError` reaches IPC through its existing `From` impl, so
  `outputTooLarge` shows up. `repo_file_text` gets a `fileMissing` code. Fetch attaches
  per-remote transport codes, and `gitError.ts` only formats them.
- `GitTransportAuthRef` in TypeScript becomes a discriminated union that mirrors the Rust
  enum field for field. `mergeOperationStatus` reads one `ACTIVE_OPERATION_KINDS` const.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `ipc/commands`: closed-set arguments reject unknown values, libgit2 failures keep their category, and every leased write reports `staleLease`.
- `history/write-ops`: the reset preview and the reset write accept the same modes.

## Non-goals

- IPC codegen (tauri-specta or schemars). That stays deferred. This change hand-mirrors
  the few types it touches.
- Rewording messages beyond the stale suffix.
- The forge capability record, which is `declare-forge-capabilities-once`. That change
  reuses the `MergeMethod`/`PrStateAction` enums defined here, so this one lands first.

## Impact

- **Processes:** Rust (`git/types/{forge,conflicts,requests,error}.rs`,
  `git/forge/prs/{mutations,merge,stacks}.rs`, `gitlab/ops.rs`, `bitbucket/ops.rs`,
  `origin/ops.rs`, `git/write/{classify,reset,recovery/reset,conflict_resolution,worktree_removal_lease}.rs`
  plus the lease-message sites, `git/transport_auth.rs`, `commands/*`), frontend
  (`src/lib/api/*`, `src/lib/gitError.ts`, `src/store/repoTypes`, `src/store` operation
  status and file-text readers).
- **IPC:** argument types for `merge_pull_request`, `set_pull_request_state`, `reset_to`,
  `continue/abort/skip_operation` become enums. The wire strings are unchanged, so the TS
  wrappers only narrow their parameter types. `CommandError` gains codes (`fileMissing`,
  per-remote transport `detail`). All four layers change together for each command.
- **Secrets/auth:** `GitTransportAuthRef` stays non-secret. The union only makes an
  invalid mode/field combination a compile error.
