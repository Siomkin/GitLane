# Design

## Context

See proposal.md for why. `rust-lints-dry-run` named `clone_on_ref_ptr` as a convention this repo already follows but left it as a follow-up for its hit count. CI runs clippy with `-D warnings` on Linux for PRs and weekly on Windows; the toolchain is pinned at 1.100.0.

## Goals / Non-Goals

**Goals:**
- `clone_on_ref_ptr` is on, and both builds (desktop `--all-targets --all-features`, agent `--all-targets --no-default-features --features agent`) are clean under `-D warnings`.
- Behaviour is identical: every rewrite calls the same `Clone` impl.

**Non-Goals:**
- Other lints, or deciding whether a given pointer clone is needed at all.

## Decisions

### Measuring

As in `rust-lints-dry-run`: one clippy run per build with `-W clippy::clone_on_ref_ptr` on the command line and `--message-format=json`, counted by primary span so an item compiled into both lib and test targets counts once. `Cargo.toml` is not touched while measuring.

### Adoption criteria

Copied from `rust-lints-dry-run`: a lint is adopted when it is worth having and fixable now. This one guards a convention the repo already follows. It is over the ~15-hit budget, which is why it has its own change, but every hit has the same mechanical fix, the one clippy suggests.

### Replacement rule

`x.clone()` on an `Arc<T>` becomes `Arc::clone(&x)`; on a `&Arc<T>` it becomes `Arc::clone(x)`. The same for `Rc` and `Weak`. The path is the short `Arc`/`Rc` already imported in the file (adding the `use` where it is missing), not clippy's fully qualified suggestion. Where the clone fed an `Arc<dyn …>` coercion, the type annotation that drove it stays.

### Suppressions

Copied from `rust-lints-dry-run`: a deliberate hit gets `#[expect(lint, reason = "…")]` on the smallest item, never a crate-wide `allow`. None was expected: there is no case where `.clone()` reads better than `Arc::clone`.

### Platform-only code

The lint only sees code compiled for the host. Windows-only (`cfg(windows)`, `cfg(not(unix))`) and Linux-only blocks were scanned for `.clone()`: none of them contains one.

## Risks / Trade-offs

- **Hit counts depend on the toolchain.** Recorded at 1.100.0.
- **A later `Arc` field can reintroduce the pattern.** That is the point of the lint: CI flags it.

## Measurements

At 1.100.0, on top of `rust-lints-dry-run` and `rust-as-conversions`:

| Build | Hits |
| --- | --- |
| desktop (`--all-targets --all-features`) | 46 |
| agent (`--all-targets --no-default-features --features agent`) | 20 (a subset of desktop) |

Top files: `remote/session/tests.rs` (5), `watcher/install.rs` (4), `remote/registry.rs` (3), `remote/registry/tests.rs` (3), `remote/e2e_tests.rs` (3), `git/write/tests/lifecycle.rs` (3), `git/credential_bridge/broker.rs` (2), `git/oauth/mod.rs` (2). Every hit is a `std::sync::Arc`; there are no `Rc` or `Weak` hits. About half are in tests. Windows- and Linux-only code adds none.
