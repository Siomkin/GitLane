# Proposal

## Why

`src-tauri` is still on Rust edition 2021, while the pinned toolchain (1.100.0) supports 2024. The 2024 edition gives tighter temporary scopes in `if let` and in tail expressions, `impl Trait` captures that are explicit, and the current `rustfmt` style. Staying on 2021 means each later migration lint adds up.

A dry run (`cargo clippy --all-targets -- -W rust-2024-compatibility`, desktop and agent feature sets, macOS) found only **9 `tail_expr_drop_order` sites** in our code and nothing else. The bump is small now, and it should go in alone, because the `rustfmt` style-edition reformat touches many files mechanically.

There is no Jira issue. This change touches **Rust only** (`src-tauri/Cargo.toml` and source formatting). No IPC, frontend or behaviour change is intended.

## What Changes

- **`edition = "2024"`** in `src-tauri/Cargo.toml`, applied with `cargo fix --edition` for both feature sets, then `cargo fmt --all` under the 2024 style edition.
- **Each `tail_expr_drop_order` site gets a review** to check whether the earlier drop of a temporary matters. Where a guard or a session must outlive the scrutinee, bind it with a named `let`. The sites are:
  - `commands/remote.rs:64`
  - `git/oauth/pkce/loopback.rs:77`
  - `git/status/stash.rs:59`
  - `git/status/working.rs:250`
  - `git/worktree_fs/handle.rs:102`
  - `remote/registry.rs:100`
  - `remote/session/tests.rs:63`
  - `updater.rs:87` (two spans)
- **Two dependency fixes the dry run surfaced:**
  - `shell-words` becomes `optional = true` and joins the `desktop` feature;
  - this clears the agent build's `unused dependency` warning, because only desktop-only modules use it (`acp/`, `terminal_agents/`).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. `skip_specs: true`: toolchain edition and formatting only, with no observable behaviour change.

## Non-goals

- **A toolchain bump.** `rust-toolchain.toml` stays at 1.100.0.
- **Adopting new 2024-only idioms** (`let` chains, `gen` blocks) beyond what `cargo fix` writes.
- **Any change from the other Rust cleanup changes** (`rust-typed-write-errors`, `rust-flag-enums-and-imports`). Land this one when neither of those is mid-flight, so the reformat does not cause merge conflicts.

## Impact

- **Code:** `src-tauri/Cargo.toml`, the 9 sites above, plus a formatting-only diff across `src-tauri/src/`.
- **Platform coverage:** the dry run covered macOS code. Windows-only code (`git/write/open_path.rs`) and Linux-only `cfg` paths (`shell/timed.rs`) are migrated by CI's Windows and Linux clippy jobs, or by running `cargo fix` on those hosts.
- **Secrets / auth / IPC risk:** none.
- **Pattern to copy:** the archived `rust-unsafe-lint-and-release-profile` change, also a tooling-only `skip_specs` change to `Cargo.toml`.
