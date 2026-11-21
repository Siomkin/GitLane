## 1. Probe result

- [x] 1.1 In `src-tauri/src/auth_providers/probe.rs`, add the private `CliProbe` enum (`Missing`, `Unverified`, `SignedIn`, `SignedOut`) with `available()` and `authenticated()`, and make `probe_cli` return it.
- [x] 1.2 In `auth_providers/status.rs`, store `CliProbe` in the probe cache and fill `available` / `authenticated` from it. Keep the no-CLI arm at `(false, None)`. Verify with `cargo check --all-targets`.
- [x] 1.3 Unit-test the mapping from each variant to `(available, authenticated)` in `probe.rs`. Verify with `cargo test auth_providers`.

## 2. Lock comments

- [x] 2.1 Add a one-line why-comment above each uncommented `poisoned.into_inner()` recovery: `watcher/install.rs` (3 sites), `diagnostics.rs` (1) and `shell/timed.rs` (1). Each says why the guarded data is still consistent after a panic.

## 3. Review follow-ups

- [x] 3.1 Split the outcome-to-variant decision into `CliProbe::from_error` and `CliProbe::from_exit`, and unit-test each outcome (missing binary, other spawn error, success with and without the required listing, failed exit).
- [x] 3.2 Correct the `diagnostics.rs` comment: the lock does guard the log file; recovery is safe because each write is a single file call.
- [x] 3.3 Say in `CliProbe::Unverified`'s doc that it reports the same as `SignedOut` and is kept apart only to name why.

## 4. Checks

- [x] 4.1 `cargo fmt --check`, clippy with `-D warnings` (desktop and agent), `cargo test` (desktop and agent) and `bun run sizes` pass. Result: 1638 desktop and 1379 agent tests, 0 failed.
