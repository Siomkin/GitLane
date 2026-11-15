# Proposal

## Why

A review of the Rust crate against a "rust-pro" checklist found it in good shape (only 13 non-test `unwrap`/`expect` calls in ~94k lines, all infallible; poisoned locks recovered; `cargo audit` gated). Two gaps remain that are cheap to close: nothing enforces a `// SAFETY:` comment on `unsafe` blocks (two blocks lack one today), and the desktop release build runs on Cargo's default profile while the remote agent's tuned profile came out about 28% smaller.

## What Changes

- Add a `[lints.clippy]` table to `src-tauri/Cargo.toml` with `undocumented_unsafe_blocks = "deny"`, so any `cargo clippy` run (local or CI, desktop or agent build) fails on an undocumented `unsafe` block.
- Add the missing `// SAFETY:` comments: `src-tauri/src/shell/timed.rs` (the `waitid` call) and `src-tauri/src/git/write/open_path.rs` (Windows `ShellExecuteW`).
- Measure candidate desktop release profiles (`lto = "thin"`, `codegen-units = 1`, and both) and adopt only one that pays off. Adoption is gated on the measured binary-size gain against the extra release build time. Measured outcome: `[profile.release] codegen-units = 1` alone (see design.md).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. `skip_specs: true`: build tooling and code comments only, no user-observable or git behavior changes.

## Non-goals

- No `clippy::unwrap_used` / `expect_used` lint: the remaining call sites are infallible and tests rely on `unwrap()`.
- No `panic = "abort"`: `commands::blocking()` turns a panicking task's `JoinError` into a `CommandError`; abort would close the app instead.
- No other profile tuning (`opt-level`, `strip` changes) and no change to `[profile.agent]`.
- No refactor of the unsafe code itself.

## Jira

None.

## Process touched

Rust only (build config + comments). No IPC, frontend, secrets, or auth surface changes.

## Impact

- `src-tauri/Cargo.toml` (lints table; possibly `[profile.release]`). `[profile.agent]` inherits `release` but already sets `lto = true` and `codegen-units = 1`, so its output is unchanged.
- `src-tauri/src/shell/timed.rs`, `src-tauri/src/git/write/open_path.rs` (comments only).
- Release CI time on the self-hosted macOS/Linux runners and the GitHub-hosted Windows leg if the profile is adopted.
- Pattern to copy: the existing `// SAFETY:` comments in `shell/timed.rs` and the `[profile.agent]` block.
