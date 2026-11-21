# Proposal

## Why

`rust-lints-dry-run` measured `clippy::as_conversions` at 83 hits (desktop) and 75 (agent), over its ~15-hit budget, and listed it as a follow-up. Its adopted `cast_possible_truncation`, `cast_possible_wrap` and `cast_sign_loss` already catch the lossy casts, but a bare `as` still hides which conversions are lossless, which saturate and which reinterpret bits. Turning on `as_conversions` makes every conversion say which it is.

There is no Jira issue. This change touches **Rust only** (`src-tauri/Cargo.toml` `[lints.clippy]` and the code the lint flags). No IPC, frontend or behaviour change for real inputs. Specs are skipped (`skip_specs`): it is a tooling refactor with no behavioural requirement.

## What Changes

- **Measure.** Re-count the lint's hits per build at today's tree, since `rust-lints-dry-run` already rewrote some casts. Record the counts and top files in `design.md`.
- **Adopt.** Add `as_conversions = "warn"` to `[lints.clippy]` in `src-tauri/Cargo.toml`, under a comment naming this change, in the style of the existing block.
- **Fix.** Replace every `as` with the narrowest correct form (`From`, `try_from` with explicit handling, `cast_signed`/`cast_unsigned`, `addr()`), or keep it under `#[expect(clippy::as_conversions, reason = …)]` where `as` is the only or clearest form. Copy the suppression rule from `rust-lints-dry-run`'s `design.md`.
- **Platform code.** Lint runs on macOS locally and Linux in CI; Windows-only code is linted only by the weekly Windows job, so its casts are fixed by hand.

## Risks

- None for secrets, auth or IPC: no command, credential path or wire type changes.
- A `try_from` that saturates differs from `as`, which wraps, past the value's range. Every such site is listed in the tasks note; none is reachable by a real input.
- Several casts feed fingerprint hashes (`discard_all`, `hard_reset_lease`, `state_lease`, `discard_file`). Those must stay byte-identical; their golden tests check it.
- Fixes may grow files toward the size ceiling. `bun run sizes` is part of the checks.

## Non-goals

- The other two `rust-lints-dry-run` follow-ups, `clone_on_ref_ptr` and `needless_pass_by_value`.
- Changing any value's type to avoid a conversion (for example making a `u64` constant `usize`).
