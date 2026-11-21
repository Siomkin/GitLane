# Design

## Context

See proposal.md for why. `rust-lints-dry-run` measured `needless_pass_by_value` and left it as a follow-up; `rust-as-conversions` adopted the other cast follow-up. CI runs clippy with `-D warnings` on Linux for PRs and weekly on Windows; the toolchain is pinned at 1.100.0.

Engine: none (no git read, write or forge behaviour changes). IPC: no command, argument name or wire type changes, so none of the four IPC layers change; the `#[tauri::command]` fns only gain an attribute. Store: none (Rust only).

## Goals / Non-Goals

**Goals:**
- `needless_pass_by_value` is on, and both builds (desktop `--all-targets --all-features`, agent `--all-targets --no-default-features --features agent`) are clean under `-D warnings`.
- Behaviour, including every emitted JSON frame and hashed byte, is identical.

**Non-Goals:**
- `clone_on_ref_ptr` (its own change), and any other lint.
- Changing a command signature, DTO or wire type to avoid the lint.

## Decisions

### Measuring

As in `rust-lints-dry-run`: one clippy run per build with `-W clippy::needless_pass_by_value` on the command line, counted by primary span so an item compiled into both lib and test targets counts once. `Cargo.toml` is not touched while measuring.

### Replacement rule

For each hit, borrow the narrowest form the body needs and update every caller, including tests and the agent bin:
- **`String` / `PathBuf`** → `&str` / `&Path`; **`Option<String>`** → `Option<&str>` (the agent `hello` frame).
- **`serde_json::Value`** → `&Value` (ACP wire writers, agent frame builders, a dispatch test helper). `json!` already serialises its operands by reference, so the bytes are unchanged.
- **`Arc` handles** (sign-in and clone slots, progress sinks, the watcher's `OnChange` and emit state) → `&Arc<…>`. The callee still clones where it stores one.
- **Owned listeners/receivers** (`TcpListener` in the credential broker and askpass loops, a test `mpsc::Receiver`) → `&…`. The caller is the `move` thread closure that already owns it, so the port still closes when that thread ends.
- **Parameter bundles of borrows** (`Turn<'_>` in ACP, `RewriteArgs<'_>` in squash) → `&Bundle<'_>`, destructured with `= *bundle` (every field is a reference or `bool`).
- **Other by-value structs** read only by reference (`BoundedOutput`, `git2::DiffFile`, `WorktreeLeafFingerprint`, `WriteError` in `after_cleanup`, `CommandError` in a test assertion) → `&T`.

### Suppressions

Copied from `rust-lints-dry-run`: a deliberate hit gets `#[expect(clippy::needless_pass_by_value, reason = "…")]` on the smallest item, never a crate-wide `allow`. Two kinds keep ownership:
- **`#[tauri::command]` fns.** Tauri extracts `State`, `AppHandle` and deserialized arguments by value; the attribute sits between `#[tauri::command]` and `pub fn`, where the registration tests' signature parser already skips attributes. Async commands are not hit (their `move` closures consume the arguments).
- **`map_err` adapters** passed point-free (`launch_error(io::Error)`, used at every `git` spawn). Rewriting each caller into a closure says less than one attribute.

Rejected: `#[expect]` on `TcpListener` loops. Borrowing does not move the drop point, because the thread closure that calls the loop owns the listener.

### Platform-only code

The lint only sees code compiled for the host. Windows-only (`cfg(windows)`, `cfg(not(unix))`) and Linux-only fns were grepped by hand for owned, unconsumed parameters. Found none: the only candidate, the Windows test helper `shell.rs` `resolved_file_name(Option<PathBuf>)`, consumes its argument through `?`, and `empty_dirs.rs`'s non-unix `new` stores its `PathBuf`.

## Risks / Trade-offs

- **Rebase onto `clone_on_ref_ptr`.** Where that change writes `Arc::clone(&slot)` and this one made `slot` a `&Arc`, the merged line becomes a `needless_borrow` error. Re-run clippy after any rebase.
- **Hit counts depend on the toolchain.** Recorded at 1.100.0.

## Measurements

At 1.100.0, on top of `rust-lints-dry-run` and `rust-as-conversions`:

| Build | Hits |
| --- | --- |
| desktop (`--all-targets --all-features`) | 41 |
| agent (`--all-targets --no-default-features --features agent`) | 20 (a subset of desktop) |

Fixing the first pass surfaced one more, `git::oauth::run_sign_in`'s slot, once its callee borrowed: 42 fixed in all.

Top files: `commands/terminal.rs` (9, all Tauri commands), `agent/protocol.rs` (3), `acp/wire.rs` (2), `diagnostics.rs` (2), `git/write/discard_file/hash.rs` (2); every other file has one.

By kind: 12 Tauri command arguments on 10 fns (kept, `#[expect]`), 1 `map_err` adapter (kept, `#[expect]`), 29 borrowed (including the follow-on hit): 7 `Arc` handles, 6 `Value`s, 6 `String`/`PathBuf`/`Option<String>`, 2 `TcpListener`s and 1 `Receiver`, 2 parameter bundles, 5 other structs.
