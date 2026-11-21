# Design

## Context

See proposal.md for why. `rust-lints-dry-run` adopted the three lossy-cast lints and left `as_conversions` as a follow-up. CI runs clippy with `-D warnings` on Linux for PRs and weekly on Windows; the toolchain is pinned at 1.100.0.

## Goals / Non-Goals

**Goals:**
- `as_conversions` is on, and both builds (desktop `--all-targets --all-features`, agent `--all-targets --no-default-features --features agent`) are clean under `-D warnings`.
- Behaviour is identical for every real input; hashed bytes are identical for every input.

**Non-Goals:**
- Other lints, or conversions that are not `as` (for example `try_into` already in the tree).

## Decisions

### Measuring

As in `rust-lints-dry-run`: one clippy run per build with `-W clippy::as_conversions` on the command line and `--message-format=json`, counted by primary span so an item compiled into both lib and test targets counts once. `Cargo.toml` is not touched while measuring.

### Replacement rule

For each `as`, the narrowest correct form:
- **Lossless widening** (`u32 → u64`, `u8 → char`, `i32 → f64`): `From`.
- **`usize → u64`**, about 55 of the hits: std has no `From` for it, because `usize` could in principle be wider. One crate helper, `crate::num::u64_from_usize`, does `u64::try_from(n).unwrap_or(u64::MAX)`. It is bit-identical on every target Rust supports and needs no `#[expect]`. It takes `usize` only, not a generic, so a site whose operand is already `u64` fails to compile instead of passing through.
- **Narrowing that real inputs never overflow** (`u64 → usize` caps, a line number, a percentage): `try_from` with an explicit saturating fallback, and the `rust-lints-dry-run` `#[expect]` that justified the old cast is removed.
- **Same-width sign change**: `cast_signed()` / `cast_unsigned()`.
- **Pointer to address** (Windows `ShellExecuteW`'s `HINSTANCE`): `addr()`.
- **`as` is the only form** (a fieldless enum's discriminant from another crate): keep it under `#[expect(clippy::as_conversions, reason = …)]`.

Rejected: one `#[expect]` per `usize → u64` site. About 55 identical suppressions say less than one named helper.

### Suppressions

Copied from `rust-lints-dry-run`: a deliberate hit gets `#[expect(lint, reason = "…")]` on the smallest item, never a crate-wide `allow`. Where an existing `#[expect(clippy::cast_*)]` covers a cast that stays, `clippy::as_conversions` joins that attribute; where the cast goes, the attribute goes too, since an unfulfilled expectation is itself a warning.

### Platform-only code

The lint only sees code compiled for the host. Windows-only (`cfg(windows)`, `cfg(not(unix))`) and Linux-only blocks are grepped for `as <type>` by hand. Found: `git/write/open_path.rs` (`HINSTANCE as usize`, twice) and `git/worktree_fs/meta.rs` (`file_attributes() as u64`).

## Risks / Trade-offs

- **Saturating is not wrapping.** Each `try_from` fallback differs from `as` only past a range no real input reaches; each is listed in the tasks note.
- **Hit counts depend on the toolchain.** Recorded at 1.100.0.

## Measurements

At 1.100.0, on top of `rust-lints-dry-run`:

| Build | Hits |
| --- | --- |
| desktop (`--all-targets --all-features`) | 80 |
| agent (`--all-targets --no-default-features --features agent`) | 72 (a subset of desktop) |

Top files: `git/worktree_fs/handle.rs` (5), `git/status/tests/diff.rs` (4), `git/status/working/new_path.rs` (4), `git/status/blob.rs` (4), `git/write/hard_reset_lease/capture.rs` (3), `git/write/files.rs` (3). Plus three Windows-only sites the macOS run cannot see.

By kind: about 60 `usize → u64` (lengths, length-prefixes in fingerprint hashes, `Read::take` limits), 6 `u64 → usize` or `usize → u32`/`u8` narrowing, 3 `u8`/`char` conversions, 2 `u32 → u64`, 1 `u64 → i64`, 1 enum discriminant, 1 `i32 → f64` in a bench.
