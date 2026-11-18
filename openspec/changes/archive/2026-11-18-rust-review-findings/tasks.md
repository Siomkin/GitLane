# Tasks

## 1. Remote-branch checkout retry error (Rust impl + tests)

- [x] 1.1 In `src-tauri/src/git/write/branch_checkout.rs`, add a private `retry_failure(remote_ref, branch, error) -> String`. It builds the message with `classify::stale(...)` and trims a trailing period from `error` (design §1). Use it in place of the `map_err(|_| …)` on the retry `advance_local_branch` call. Verify: `cargo check` passes and `grep -n "map_err(|_|" src-tauri/src/git/write/branch_checkout.rs` prints nothing.
- [x] 1.2 Add unit tests for `retry_failure` covering:
  - the message contains the remote ref and the inner git error;
  - `classify_failure` on the message returns `CommandErrorKind::StaleLease`;
  - an inner error ending in "." doesn't produce "..";
  - an inner error that already holds a redacted credential comes through unchanged, with no raw secret (spec scenario 2).

  Verify: `(cd src-tauri && cargo test retry_failure)` runs at least four tests and all pass.
- [x] 1.3 Add an integration case to `src-tauri/src/git/write/tests/branch_checkout/refuses.rs`. With `refs/heads/develop.lock` held, checking out `origin/develop` fails; HEAD, the working tree and `develop` are unchanged; and the error contains git's lock text. This covers the first-attempt path and locks in git's own text reaching the user (design §1). Verify: `(cd src-tauri && cargo test branch_checkout)` passes, including the new test.

## 2. OAuth parse errors keep a safe cause (Rust impl + tests)

- [x] 2.1 Add `parse_detail(&serde_json::Error) -> String` in `src-tauri/src/git/oauth/`, built from `classify()`, `line()` and `column()` only (design §2). Use it at `device.rs:104`, `pkce/exchange.rs:36`, `identity.rs:72` and `identity.rs:95`, keeping each friendly sentence. Verify: `cargo check` passes.
- [x] 2.2 Add leak tests for the device-code and both identity parsers. Each body puts a secret string (`SECRETVALUE123`) where the DTO expects a number, for example `"expires_in"` or `"id"`. Each test asserts that `serde_json::from_str::<Dto>(body).unwrap_err().to_string()` **does** contain the secret, and that the returned message contains `line` and does **not** contain it. For `exchange.rs`, add a malformed-JSON test asserting that the message contains `line`. Verify: `(cd src-tauri && cargo test oauth)` passes.

## 3. Squash precondition distinguishes "gone" from "unreadable" (Rust impl + tests)

- [x] 3.1 In `src-tauri/src/git/write/squash_range/target.rs`, keep the current message for `ErrorCode::NotFound` and return `Could not read refs/heads/{branch}: {e}` otherwise (design §3). Verify: `cargo check` passes.
- [x] 3.2 Add tests for both branches: a deleted branch still yields "Target branch changed or was deleted", and a malformed loose ref (garbage in `.git/refs/heads/<branch>`) yields "Could not read refs/heads/". If libgit2 reports the malformed ref as `NotFound`, split out the error mapping and test it on a constructed `git2::Error` instead. Verify: `(cd src-tauri && cargo test squash)` passes, including both new tests.

## 4. Panic and cast cleanups (Rust impl + tests)

- [x] 4.1 In `src-tauri/src/watcher.rs:66`, seed `last` with `Instant::now().checked_sub(THROTTLE).unwrap_or_else(Instant::now)`. Verify: `(cd src-tauri && cargo test watcher)` passes.
- [x] 4.2 In `src-tauri/src/git/forge/diff/path.rs:91`, replace `val as u8` with `u8::try_from(val).unwrap_or(u8::MAX)`. Add unit tests: `\377` decodes to byte 255, and `\400` (256) decodes to 255, not to byte 0 through wrapping. Verify: `(cd src-tauri && cargo test diff::path)` passes.
- [x] 4.3 In `src-tauri/src/agent/protocol.rs:88-96` and `src-tauri/build.rs:17`, replace `unwrap()` with `expect("<invariant>")`. Verify: `grep -n "\.unwrap()" src-tauri/src/agent/protocol.rs src-tauri/build.rs` prints nothing.
- [x] 4.4 Replace `unwrap()` with `expect("<what the fixture guarantees>")` in test code gated by `cfg(all(test, …))`, which `allow-unwrap-in-tests` doesn't cover (design §5):
  - `src-tauri/src/smoke.rs`;
  - `git/write/state_lease/golden_fixture.rs`;
  - `git/write/hard_reset_lease/golden_tests.rs`;
  - `git/write/discard_all/golden_tests.rs`;
  - `git/worktree_fs/tests.rs`;
  - the test code in `git/write/cli.rs`.

  Verify: with task 6.2's `clippy.toml` in place, `(cd src-tauri && cargo clippy --all-targets --all-features -- -W clippy::unwrap_used)` reports no `unwrap_used`.

## 5. `#[allow]` reasons (Rust)

- [x] 5.1 Add `reason = "…"` to all 21 sites listed in design §6, keeping each `cfg_attr` condition. `forge/dto/head_ref.rs:47` stays `allow` with a reason. Verify: `(cd src-tauri && cargo clippy --all-targets --all-features -- -W clippy::allow_attributes_without_reason)` reports nothing.
- [x] 5.2 Run a cross-platform check, because the Windows-only and non-unix sites are invisible to macOS clippy. Verify: `grep -rn -A2 "allow(" src-tauri/src src-tauri/build.rs` shows `reason =` in every attribute. Check `lib.rs:15` (multi-line) by eye.

## 6. Lint subset (config)

- [x] 6.1 In the `[lints.clippy]` table in `src-tauri/Cargo.toml`, add `unwrap_used`, `allow_attributes_without_reason` and `unchecked_time_subtraction` as `"warn"`, keeping `undocumented_unsafe_blocks = "deny"`. Add a one-line comment naming the BeautifulRust review. Verify: the table lists four lints.
- [x] 6.2 Create `src-tauri/clippy.toml` containing `allow-unwrap-in-tests = true`. Verify: `(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings)` exits 0.
- [x] 6.3 Verify: `(cd src-tauri && cargo clippy --all-targets --no-default-features --features agent -- -D warnings)` exits 0. Fix any remaining agent-only hit the same way as in 4.4 or 5.1.

## 7. Integration checks

- [x] 7.1 Run `(cd src-tauri && cargo fmt --all -- --check)`, `(cd src-tauri && cargo test)` and `(cd src-tauri && cargo test --no-default-features --features agent)`. All three exit 0.
- [x] 7.2 Run `bun run sizes`. It exits 0, with no touched Rust file above the 400-line ceiling.
