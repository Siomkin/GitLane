## 1. Measure

- [x] 1.1 Count `needless_pass_by_value` hits per build with `-W clippy::needless_pass_by_value`, deduped by span, and record them with the top files in `design.md` § Measurements.

## 2. Adopt

- [x] 2.1 Add `needless_pass_by_value = "warn"` to `[lints.clippy]` in `src-tauri/Cargo.toml` under a comment naming this change.
- [x] 2.2 Put `#[expect(clippy::needless_pass_by_value, reason = "Tauri extracts command arguments by value")]` between `#[tauri::command]` and `pub fn` on each hit command fn (`commands/terminal.rs` ×7, `auth.rs`, `github.rs`, `repo.rs`), then run the registration tests.
- [x] 2.3 Keep `git::write::cli::launch_error` owned under an `#[expect]`: it is a point-free `map_err` adapter.
- [x] 2.4 Borrow at every other hit with the replacement rule in `design.md` and update every caller (tests, the agent bin, the desktop commands). Fix the follow-on hit and the `needless_borrow`s the first pass surfaces. List every change that is not mechanically identical in this task's note.
  - Note: all are call-for-call identical except these, none of which changes behaviour. `Turn<'_>` and `RewriteArgs<'_>` are passed as `&…` and destructured from `*turn` / `*args`. The broker and askpass `serve` loops borrow their `TcpListener`; the `move` thread closure that calls each still owns it, so the port closes at the same point. `diagnostics::escape_marks` takes `&str`; its `replace` already allocated a new `String`, so the allocation count is the same. `agent::protocol::hello` takes `Option<&str>` for `git` and `home` (callers pass `.as_deref()`); the frame's JSON is unchanged, as `json!` serialises by reference. `after_cleanup` matches on `&WriteError` and builds the same variant.
- [x] 2.5 Grep Windows- and Linux-only code for owned, unconsumed parameters and fix them by hand.
  - Note: none found (see `design.md` § Platform-only code). Not compiled here; the weekly Windows clippy job is the check.

## 3. Checks

- [x] 3.1 `cargo fmt --check`, clippy with `-D warnings` (desktop and agent), `cargo test` (desktop and agent) and `bun run sizes` pass.
