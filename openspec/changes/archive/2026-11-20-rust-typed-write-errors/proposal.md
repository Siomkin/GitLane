# Proposal

## Why

The write layer (`src-tauri/src/git/write/`) returns `Result<_, String>` from about 310 functions. Every failure gets its `CommandErrorKind` only at the IPC edge, where `impl From<String> for CommandError` runs `classify::classify_failure` over the text. For git's own stderr that is the only option. GitLane also classifies its *own* messages that way:

- a stale lease is recognised only because the message ends with `STALE_SUFFIX` ("Refresh and try again.");
- `alreadyARepository` is recognised only because the text contains "is already a Git repository".

`discard_file/discard.rs` even branches on `error.ends_with(STALE_SUFFIX)`. Rewording one of these sentences silently changes the error kind the frontend branches on, and only a test that pins the literals catches it.

This change adds a typed write error that records the kind where GitLane creates the failure. It pilots the type on two small modules, so later migrations become mechanical and can go in one module at a time.

There is no Jira issue. This change touches **Rust only**: no IPC signature, no wire format and no frontend change.

## What Changes

- **New `WriteError` type** in `git/write/`, built with `thiserror` (already a dependency). It has one variant per failure GitLane itself detects (stale lease, already a repository), plus a `Git(String)` variant that carries git's own diagnostic text unchanged.
- **`From<WriteError> for CommandError`:**
  - the GitLane-authored variants map straight to their kind and code;
  - `Git(String)` still goes through `classify_failure`, which stays as it is.
- **Coexistence conversions** keep migration incremental:
  - `From<String> for WriteError` (to `Git`) lets a migrated function `?` an unmigrated helper;
  - `From<WriteError> for String` (the same message text) lets an unmigrated caller `?` a migrated function. That text still ends with `STALE_SUFFIX`, so the existing classifier keeps reporting the same kind.
- **The pilot migrates two modules:**
  - `git/write/discard_file/`: its stale-lease producers, and the `ends_with(STALE_SUFFIX)` branch in `discard.rs` becomes a `match` on the variant;
  - `git/write/lifecycle/init.rs`: both "already a Git repository" producers become one typed variant carrying the `alreadyARepository` code.
- **The `CommandError` JSON stays byte-identical** for every pilot path (same kind, code, message and detail). The existing `classify` tests and new pilot tests pin this.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. `skip_specs: true`. This is a pure refactor: `ipc/commands` already requires classification in the backend, and the kinds and messages the frontend receives do not change.

## Non-goals

- **Migrating the rest of `git/write/`.** The remaining lease producers (worktrees, `index_lock.rs`, reset, `force_push`, head, `discard_all`, `squash_range` and others, about 20 files) become their own follow-up changes, one module family each, after this pilot lands.
- **Removing `classify_failure` or `From<String> for CommandError`.** git's auth, network, conflict and hook failures exist only as stderr text, so text classification stays for them. Removing the shim only becomes possible once no module returns `String`.
- **Forcing git into the C locale** to make stderr matching locale-proof. That changes what users see and is a separate decision.
- **Typed errors outside `git/write/`** (`oauth`, `remote`, `acp`, `forge`).
- **Any change to `CommandErrorKind`, the wire format, or the frontend's `gitError.ts`.**

## Impact

- **Code:**
  - `src-tauri/src/git/write/`: the new error module, `classify.rs` (only if a shared helper moves), `discard_file/*`, `lifecycle/init.rs`;
  - `src-tauri/src/git/types/error.rs`: the `From` impl, unless it lives next to `WriteError`.
- **Callers:** `commands/staging.rs` (discard) and `commands/repo.rs` (init) need no change, because `blocking` accepts any `E: Into<CommandError>`.
- **Secrets / auth / IPC risk:** none. Messages are the same, already-redacted strings, and no command signature changes.
- **Pattern to copy:** `git/forge/bounded_output/error.rs` and `secrets.rs` already use `thiserror` enums in this crate.
