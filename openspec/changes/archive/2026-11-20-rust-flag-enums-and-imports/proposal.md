# Proposal

## Why

Several crate-visible Rust functions take a `bool` that picks a mode. At the call site that reads as `checkout(repo, target, true)` or `decode_lossy(s, false)`, which says nothing, and a third mode cannot be added later. Five `git/forge/prs/*` files also glob-import `super::super::dto::*`, which hides which DTOs each file depends on. Both are cheap to fix while the code is small and well tested.

There is no Jira issue. This change touches **Rust only**: no IPC signature, wire format or frontend change.

## What Changes

- **Mode enums replace `bool` parameters** on these crate-visible functions:
  - `git::write::branch_checkout::checkout(.., detached: bool)` → a `CheckoutMode { Branch, Detached }` argument;
  - `git::write::ignore::append_ignore_pattern(.., local: bool)` → `IgnoreFile { Gitignore, InfoExclude }`;
  - `updater::check(.., beta: bool)`, `updater::release_notes(.., beta: bool)`, `endpoint_for(beta)` and the two `updater/release_notes.rs` helpers → one `Channel { Stable, Beta }`;
  - `percent::decode_lossy(.., plus_as_space: bool)` → `PlusSign { Literal, Space }`;
  - `git::write::patch_staging::runners::patch_diff_args(staged: bool, ..)` → `IndexSide { Staged, Unstaged }`.
- **Command parameters stay `bool`.** The three that cross IPC (`detached`, `local`, `beta`) keep their wire `bool` in `commands/branches.rs`, `commands/staging.rs` and `commands/updater.rs`, which convert them to the enum in one line. The agent's `dispatch.rs` calls those command fns, so it needs no change.
- **Explicit imports** replace `use super::super::dto::*` in `git/forge/prs/{commits,merge,mutations,reads,stacks}.rs`. The `use super::support::*` globs in `forge/diff/parser_tests/` are test helpers and stay, which the guide allows.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. `skip_specs: true`: a pure refactor with identical behaviour and no wire change.

## Non-goals

- **Changing any IPC argument type,** the TS wrappers or the agent dispatch table.
- **Private helpers whose callers sit a few lines away.** The guide exempts these: `run_git_credential`, `find_options`, `status_for`, `survives_in_preimage`, `write_browser_response` and `obstruction_key`.
- **Reshaping `auth_providers::probe::probe_cli`'s `(bool, Option<bool>)` return.** It is worth a typed result, but that is its own small change.
- **Clone reduction in the forge DTO mappers.** Only worth doing if profiling shows a hot path.

## Impact

- **Code:**
  - `src-tauri/src/git/write/{branch_checkout,ignore}.rs` and `patch_staging/{runners,apply,range}.rs`;
  - `src-tauri/src/{updater.rs,updater/release_notes.rs,percent.rs}`;
  - the two `decode_lossy` callers (`git/oauth/pkce/loopback.rs`, `redact.rs`);
  - `commands/{branches,staging,updater}.rs`;
  - `git/forge/prs/*`;
  - the matching tests (`git/write/tests/branch_checkout/*`, `tests/staging/hunks.rs`, `updater/tests.rs`, `percent.rs` tests).
- **Secrets / auth / IPC risk:** none. No command signature changes.
- **Pattern to copy:** small `Copy` enums next to their function, like `CommandErrorKind` and `ConflictSide` in `git/types/`. They need no serde, because none of them crosses IPC.
