## 1. Measure

- [x] 1.1 List every candidate from BeautifulRust's `lints.toml` that `src-tauri/Cargo.toml` does not already set, including each lint the `pedantic` group would enable. Write the list into `design.md` § Measurements.
- [x] 1.2 Run clippy once per build (desktop: `--all-targets --all-features`; agent: `--all-targets --no-default-features --features agent`) with every candidate passed as `-W`. Count hits per lint from `--message-format=json`, deduped by span, without editing `Cargo.toml`.
- [x] 1.3 Fill in the Measurements table: lint, desktop hits, agent hits, top files, decision (*adopt*, *skip*, *follow-up*) and a one-line reason, applying the criteria in `design.md`.

## 2. Adopt

- [x] 2.1 Add each *adopt* lint to `[lints.rust]` or `[lints.clippy]` in `src-tauri/Cargo.toml`, one line each with a source comment.
- [x] 2.2 Fix or `#[expect(…, reason = …)]` every hit of the adopted lints. Call out any fix that is not mechanically equivalent (casts, removed clones) in the task's note.
  - Note: not mechanically equivalent, all only past a range no real input reaches. `diagnostics.rs` log size: `usize::try_from(..).unwrap_or(usize::MAX)` plus `saturating_add`, so an oversized log rotates instead of wrapping on 32-bit. The ignored-file counts (`worktree_removal_lease.rs`, `worktrees/dirty.rs`) saturate at `u32::MAX`, and upload progress (`remote/install.rs`) saturates at 100. `O_NONBLOCK` uses `cast_signed()`, which is bit-identical. The range-safe casts (two byte caps, a diff line number, epoch days, the index stage) keep `as` under an `#[expect]` that states the range. The 15 `redundant_clone` removals are moves of values never used again. Three `dead_code` expectations gained `not(test)`, because unit tests use those items.
- [x] 2.3 List the *follow-up* lints with their hit counts at the end of `design.md`.

## 3. Checks

- [x] 3.1 `cargo fmt --check`, clippy with `-D warnings` (desktop and agent), `cargo test` (desktop and agent) and `bun run sizes` pass.
