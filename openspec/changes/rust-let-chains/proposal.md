# Proposal

## Why

The edition 2024 move (`rust-edition-2024`) left 31 nested `if` / `if let` sites, in 23 functions, that `clippy::collapsible_if` now wants written as let-chains. Each function carried `#[expect(clippy::collapsible_if, reason = …)]` so that move stayed mechanical. This change does the conversion and removes those attributes.

There is no Jira issue. This change touches **Rust only**. No IPC, frontend or behaviour change is intended.

## What Changes

- Remove the 23 `#[expect(clippy::collapsible_if)]` attributes.
- Collapse each nested `if` into one `if … && let …` chain with `cargo clippy --fix` (desktop and agent feature sets), then `cargo fmt --all`.
- clippy only collapses an outer `if` with no `else` whose body is the inner `if` alone, so each rewrite keeps the same control flow.

## Impact

- 20 files under `src-tauri/src`, about 100 lines shorter overall.
- Specs are skipped: this is a pure refactor.
