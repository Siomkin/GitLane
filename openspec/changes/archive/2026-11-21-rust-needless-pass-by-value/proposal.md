# Proposal

## Why

`rust-lints-dry-run` measured `clippy::needless_pass_by_value` at 41 hits (desktop) and 20 (agent) and left it as a follow-up, rated perf-oriented. It is adopted now anyway: a parameter taken by value that the body only reads makes every caller give up (or clone) something the function never keeps, and the signature misstates what the function does with its input.

There is no Jira issue. This change touches **Rust only** (`src-tauri/Cargo.toml` `[lints.clippy]` and the code the lint flags). No IPC, frontend or behaviour change. Specs are skipped (`skip_specs`): it is a tooling refactor with no behavioural requirement.

## What Changes

- **Measure.** Re-count the lint's hits per build at today's tree (after `rust-lints-dry-run` and `rust-as-conversions`) and record the counts and top files in `design.md`.
- **Adopt.** Add `needless_pass_by_value = "warn"` to `[lints.clippy]` in `src-tauri/Cargo.toml`, under a comment naming this change, in the style of the existing block (copy `rust-as-conversions`).
- **Fix.** Borrow instead (`&str`, `&Path`, `&[T]`, `&T`, `&Arc<…>`) and update every caller. Where a framework requires ownership, keep it under `#[expect(clippy::needless_pass_by_value, reason = …)]` on the smallest item, per the suppression rule in `rust-lints-dry-run`'s `design.md`.
- **Platform code.** The lint runs on macOS locally and Linux in CI; Windows-only code is linted only by the weekly Windows job, so it is checked by hand.

## Risks

- **IPC:** `#[tauri::command]` fns must keep owned `State`, `AppHandle` and deserialized arguments; Tauri extracts them by value. They get an `#[expect]` instead of a signature change, so no command name, argument name or wire type changes and the registration tests stay green.
- **Secrets/auth:** none. The OAuth and `gh` sign-in slots and the credential/askpass loopback listeners only change from owned to borrowed handles; the listener is still dropped by the same caller at the same point.
- **Remote agent:** `agent/protocol.rs` frame builders and `agent/serve.rs` borrow instead; the JSON they emit is unchanged.
- Fixes may grow files toward the size ceiling. `bun run sizes` is part of the checks.

## Non-goals

- The sibling follow-up `clone_on_ref_ptr` (its own change).
- Changing any command signature, wire type or DTO to avoid the lint.
- Reworking ownership beyond what each hit needs.
