# Proposal

## Why

Two small items the Rust best-practices review deferred:

- `auth_providers::probe::probe_cli` returns `(bool, Option<bool>)`. Its four outcomes are carried as a pair whose meaning lives only in the function body: CLI missing, CLI present but unverified (timeout or capture failure), signed in, signed out. `rust-flag-enums-and-imports` called this "worth a typed result, but … its own small change".
- Seven mutex recoveries (`.unwrap_or_else(|poisoned| poisoned.into_inner())`) in `watcher/`, `shell/timed.rs` and `diagnostics.rs` keep going after a panic poisoned the lock. Two say why that is safe. The other five do not, so a reader cannot tell a deliberate recovery from a shortcut. `rust-review-findings` deferred these comments.

There is no Jira issue. This change touches **Rust only**. No IPC, wire format or frontend change. Specs are skipped: it is a pure refactor with no behaviour change.

## What Changes

- **Probe result:** add a private `CliProbe` enum in `auth_providers/probe.rs` with four variants, `Missing`, `Unverified`, `SignedIn` and `SignedOut`. `probe_cli` returns it, and its `available()` / `authenticated()` methods map it back to the two `ForgeAuthStatus` fields exactly as today:
  - `Missing` → `(false, None)`
  - `Unverified` and `SignedOut` → `(true, Some(false))`
  - `SignedIn` → `(true, Some(true))`
- `status.rs`'s per-scan probe cache stores `CliProbe` instead of the pair. The `None` arm for a provider without a CLI keeps reporting `(false, None)`.
- **Lock comments:** one line at each of the five uncommented recoveries, saying why the guarded data is still consistent after a panic. The sites are `watcher/install.rs` (lines 118, 128, 155), `diagnostics.rs` (107) and `shell/timed.rs` (82). The two existing comments (`watcher/commondir.rs:50`, `watcher/install.rs:187`) stay as they are.

Copy the enum style from `git/forge/modes.rs` (`BranchAfterMerge`), which replaced a `bool` the same way in `rust-flag-enums-and-imports`.

## Risks

- None for secrets, auth or IPC: the probe reads only exit status and whether stdout is empty, and `ForgeAuthStatus` keeps its fields and values.
- `require_output` stays a `bool`. It is a per-provider data field in `spec.rs`, not a mode a caller picks.

## Non-goals

- Changing how a probe is run, timed out or cached, or which providers are probed.
- A shared `lock_recovering` helper, or a different poison policy. The recoveries are deliberate; this change only documents them.
- Recoveries outside `watcher/`, `shell/timed.rs` and `diagnostics.rs`.
