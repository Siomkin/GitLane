## 1. Conversion

- [x] 1.1 Remove the 23 `#[expect(clippy::collapsible_if, reason = …)]` attributes.
- [x] 1.2 Apply clippy's let-chain fixes for the desktop and agent feature sets, then `cargo fmt --all`.
- [x] 1.3 Read the diff: every rewrite collapses an outer `if` with no `else`, so control flow is unchanged.

## 2. Checks

- [x] 2.1 `cargo fmt --check`, clippy with `-D warnings` (desktop and agent), `cargo test` (desktop and agent) and `bun run sizes` pass. Result: 1626 desktop and 1370 agent tests, 0 failed.
