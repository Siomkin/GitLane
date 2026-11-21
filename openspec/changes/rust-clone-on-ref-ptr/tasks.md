## 1. Measure

- [x] 1.1 Count `clone_on_ref_ptr` hits per build with `-W clippy::clone_on_ref_ptr` and `--message-format=json`, deduped by span, and record them with the top files in `design.md` § Measurements.

## 2. Adopt

- [x] 2.1 Add `clone_on_ref_ptr = "warn"` to `[lints.clippy]` in `src-tauri/Cargo.toml` under a comment naming this change.
- [x] 2.2 Rewrite every hit with the replacement rule in `design.md`. List any fix that is not the mechanical `Arc::clone` rewrite, and any `#[expect]`, in this task's note.
  - Note: all 46 are the mechanical rewrite; no `#[expect]` was needed. Files that already wrote `std::sync::Arc::new` fully qualified (`commands/github.rs`, `commands/repo.rs`, `git/write/tests/lifecycle.rs`) use `std::sync::Arc::clone`; `commands/auth.rs` and `git/oauth/mod.rs` gained `use std::sync::Arc;`.
- [x] 2.3 Scan Windows- and Linux-only code for `.clone()` on an `Arc`/`Rc` and fix it by hand.
  - Note: none found. Not compiled here; the weekly Windows clippy job is the check.

## 3. Checks

- [x] 3.1 `cargo fmt --check`, clippy with `-D warnings` (desktop and agent), `cargo test` (desktop and agent) and `bun run sizes` pass.
