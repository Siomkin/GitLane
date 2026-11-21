## 1. Measure

- [x] 1.1 Count `as_conversions` hits per build with `-W clippy::as_conversions` and `--message-format=json`, deduped by span, and record them with the top files in `design.md` § Measurements.

## 2. Adopt

- [x] 2.1 Add `as_conversions = "warn"` to `[lints.clippy]` in `src-tauri/Cargo.toml` under a comment naming this change.
- [x] 2.2 Add `crate::num::u64_from_usize` and use it for every `usize → u64` cast, and its saturating reverse `usize_from_u64` for the `u64 → usize` caps. Import them per file with `use crate::num::{…};`.
- [x] 2.3 Fix every other hit with the replacement rule in `design.md`, removing `rust-lints-dry-run` `#[expect]`s whose cast is gone. List every fix that is not bit-identical in this task's note.
  - Note: not bit-identical, all only past a range no real input reaches, and all saturating where `as` wrapped or truncated. The two read caps (`MAX_EDITABLE_BYTES`, `cap ≤ MAX_TEXT_BYTES`) saturate at `usize::MAX`; both are 2 MiB. The two `Vec::with_capacity` hints (≤ 1 MiB) fall back to 0. The untracked-file line number (`working/new_path.rs`) saturates at `u32::MAX`. The hashed index stage (`discard_file/hash.rs`, 0..=3) saturates at 255, so hashed bytes are unchanged for every real stage. Clone progress (≤ 100 by `min`) and agent-download progress (`.min(100)` kept) fall back to 100. The staged-patch origin byte now goes through `u8::try_from(char)` and matches the same three ASCII origins. Bit-identical: every `usize → u64` (via `crate::num::u64_from_usize`, including all hashed length prefixes), `u64 → i64` epoch days (`cast_signed`), `u8 → char`, `u32 → u64` (`metadata.mode()`, Windows `file_attributes()`), Windows `HINSTANCE` (`addr()`), and the bench's `i32 → f64` (its `iterations` is now annotated `i32`, the type it already inferred). The `git2::Delta` status byte in `discard_file/hash.rs` is an explicit `match` (`delta_byte`) giving each variant its old discriminant, pinned by a unit test, so lease tokens are unchanged. `hash_index_entry` keeps its 0..=3 stage precondition as a `debug_assert!`. Each `Read::take(u64_from_usize(n) + 1)` limit uses `saturating_add(1)`, the same value for every real `n`. The five `rust-lints-dry-run` `#[expect(clippy::cast_*)]`s on the rewritten casts were removed.
- [x] 2.4 Grep Windows- and Linux-only code for `as <type>` and fix it by hand.
  - Note: found `git/write/open_path.rs` (`ShellExecuteW`'s `HINSTANCE as usize`, twice → `addr()`) and `git/worktree_fs/meta.rs` (`file_attributes() as u64` → `u64::from`). No Linux-only `as` casts. Not compiled here; the weekly Windows clippy job is the check.

## 3. Checks

- [x] 3.1 `cargo fmt --check`, clippy with `-D warnings` (desktop and agent), `cargo test` (desktop and agent) and `bun run sizes` pass.
