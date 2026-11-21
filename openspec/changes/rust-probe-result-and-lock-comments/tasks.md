## 1. Probe result

- [ ] 1.1 In `src-tauri/src/auth_providers/probe.rs`, add the private `CliProbe` enum (`Missing`, `Unverified`, `SignedIn`, `SignedOut`) with `available()` and `authenticated()`, and make `probe_cli` return it.
- [ ] 1.2 In `auth_providers/status.rs`, store `CliProbe` in the probe cache and fill `available` / `authenticated` from it. Keep the no-CLI arm at `(false, None)`. Verify with `cargo check --all-targets`.
- [ ] 1.3 Unit-test the mapping from each variant to `(available, authenticated)` in `probe.rs`. Verify with `cargo test auth_providers`.

## 2. Lock comments

- [ ] 2.1 Add a one-line why-comment above each uncommented `poisoned.into_inner()` recovery: `watcher/install.rs` (3 sites), `diagnostics.rs` (1) and `shell/timed.rs` (1). Each says why the guarded data is still consistent after a panic.

## 3. Checks

- [ ] 3.1 `cargo fmt --check`, clippy with `-D warnings` (desktop and agent), `cargo test` (desktop and agent) and `bun run sizes` pass.
