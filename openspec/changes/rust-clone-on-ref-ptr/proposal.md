# Proposal

## Why

`rust-lints-dry-run` measured `clippy::clone_on_ref_ptr` at 47 hits (desktop) and 21 (agent), over its ~15-hit budget, and listed it as a follow-up. A `.clone()` on an `Arc` or `Rc` reads the same as a deep clone of the value inside, though it only bumps a reference count. The repo already writes the cheap form explicitly in places (`shell/timed.rs` has `Arc::clone(&child)`); turning the lint on makes that the rule everywhere.

There is no Jira issue. This change touches **Rust only** (`src-tauri/Cargo.toml` `[lints.clippy]` and the code the lint flags). No IPC, frontend or behaviour change: `x.clone()` and `Arc::clone(&x)` call the same function. Specs are skipped (`skip_specs`): it is a tooling refactor with no behavioural requirement.

## What Changes

- **Measure.** Re-count the lint's hits per build at today's tree, now that `rust-lints-dry-run` and `rust-as-conversions` have landed. Record the counts and top files in `design.md`.
- **Adopt.** Add `clone_on_ref_ptr = "warn"` to `[lints.clippy]` in `src-tauri/Cargo.toml`, under a comment naming this change, in the style of the existing block.
- **Fix.** Rewrite every hit as `Arc::clone(&x)` / `Rc::clone(&x)` (or the matching `Weak`). A deliberate hit would get `#[expect(clippy::clone_on_ref_ptr, reason = …)]`, copying the suppression rule from `rust-lints-dry-run`'s `design.md`.
- **Platform code.** Lint runs on macOS locally and Linux in CI; Windows-only code is linted only by the weekly Windows job, so its `Arc`/`Rc` clones are checked by hand.

## Risks

- None for secrets, auth or IPC: no command, credential path or wire type changes.
- None for behaviour: the rewrite calls the same `Clone` impl.
- Rewrites can push a line past `rustfmt`'s width and grow a file by a line or two; `cargo fmt --check` and `bun run sizes` are part of the checks.

## Non-goals

- The last `rust-lints-dry-run` follow-up, `needless_pass_by_value`, which a sibling change adopts.
- Removing clones that could be borrows instead; that is `redundant_clone`'s job, already adopted.
