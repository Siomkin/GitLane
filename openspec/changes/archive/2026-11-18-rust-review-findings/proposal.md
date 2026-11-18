# Proposal

## Why

We reviewed `src-tauri` against the BeautifulRust `rust-review` checklist and its lint set, running clippy on shipped code and tests separately. The review found one misleading user-facing error, a few error paths that throw away the cause a support log needs, and some lint gaps that let those slip in. They are cheap to close while the review is fresh.

There is no Jira issue. This change touches **Rust only**: no IPC signature, store or frontend change.

## What Changes

- **Remote-branch checkout retry names the real failure.** Today, when checking out a remote-tracking ref has to retry moving the local branch and the retry fails, the user is always told the remote "kept moving", whatever the actual cause was (ref lock, permission, refused update). The message will keep the retry context and add the underlying git error, which the git subprocess layer has already redacted. It stays a stale-lease error, so the frontend handles it as it does today.
- **Error paths keep their cause** where it is currently thrown away and the friendly text alone cannot be diagnosed:
  - the OAuth device-code, token-exchange and GitLab/Bitbucket identity parses (`git/oauth/device.rs`, `pkce/exchange.rs`, `identity.rs`). These append only the serde error category and its line and column, never the error's `Display`, because that can quote response values;
  - the other-branch squash precondition (`git/write/squash_range/target.rs`), which tells "branch is gone" apart from "could not read the reference".
- **Small panic and cast cleanups:**
  - `watcher.rs` throttle seed uses `checked_sub`;
  - the octal unescape in `git/forge/diff/path.rs` stops wrapping out-of-range values;
  - `agent/protocol.rs` and `build.rs` use `expect("why")` instead of bare `unwrap()`;
  - test code gated by `cfg(all(test, …))` gets the same treatment: `smoke.rs`, the golden-fixture and golden tests, `worktree_fs/tests.rs` and the test code in `write/cli.rs`. Clippy's `allow-unwrap-in-tests` setting only recognises a bare `#[cfg(test)]`, so these would otherwise trip the new lint.
- **Every `#[allow(...)]` gives a reason**, including the `cfg_attr(…, allow(…))` forms that only compile on one OS (21 sites).
- **Lint subset adopted** in `src-tauri/Cargo.toml` `[lints.clippy]`: `unwrap_used`, `allow_attributes_without_reason` and `unchecked_time_subtraction`, plus a new `src-tauri/clippy.toml` with `allow-unwrap-in-tests = true`. CI already runs clippy with `-D warnings` for both the desktop and the agent feature sets, so these become gates with no workflow change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `history/write-ops`: adds one requirement, that a failed remote-branch checkout retry reports the underlying cause instead of a fixed "kept moving" message.

## Non-goals

- Migrating the internal `Result<_, String>` errors (528 signatures) to typed errors or `thiserror`.
- Enabling the rest of BeautifulRust's `lints.toml`. Out of scope:
  - `pedantic`, `unreachable_pub`, `as_conversions`, `indexing_slicing` and `map_err_ignore`;
  - the library-only lints `missing_docs`, `missing_errors_doc` and `exhaustive_enums`.

  For this application they are mostly noise. The review read every indexing site in the parsers and found all of them bounds-checked.
- Rewording the deliberately user-friendly `map_err(|_| …)` messages that replace an error users don't need, such as UTF-8, clone destination and remote URL validation.
- Adding comments to the poisoned-lock `into_inner` recoveries in `watcher/`, `shell/timed.rs` and `diagnostics.rs`.
- Any frontend, IPC or spec change beyond the one requirement above.

## Secrets / auth risk

The OAuth parse errors run on provider responses that contain tokens and device codes. Including `serde_json::Error`'s `Display` could quote a field value, for example "invalid type: string \"…\"". So these sites append only `e.classify()` and `e.line()`/`e.column()`, and no response bytes. The checkout message wraps an error whose git stderr was already redacted at the subprocess boundary (`git/write/cli/finish.rs`), so it adds no redaction of its own. No new command takes a credential.

## Impact

- **Rust:**
  - `git/write/branch_checkout.rs`;
  - `git/oauth/{device,identity}.rs` and `git/oauth/pkce/exchange.rs`;
  - `git/write/squash_range/target.rs`;
  - `watcher.rs`, `git/forge/diff/path.rs`, `agent/protocol.rs` and `build.rs`;
  - test code gated by `cfg(all(test, …))`: `smoke.rs`, `git/write/state_lease/golden_fixture.rs`, `git/write/hard_reset_lease/golden_tests.rs`, `git/write/discard_all/golden_tests.rs`, `git/worktree_fs/tests.rs` and `git/write/cli.rs`;
  - the 21 reason-less `#[allow]` / `cfg_attr(…, allow(…))` sites, which design §6 lists;
  - `Cargo.toml` `[lints.clippy]` and a new `clippy.toml`.
- **Tests:**
  - a unit test for the checkout retry message, plus an integration case in `git/write/tests/branch_checkout/` showing a held branch lock surfaces git's own text;
  - OAuth parse tests that put a secret where serde would quote it, and assert that the message leaves it out;
  - a test for the squash precondition's "unreadable" branch;
  - unit tests for the octal clamp.
- **Copy from:**
  - the checkout retry message uses the existing `classify::stale(...)` helper;
  - there is no `#[allow(..., reason = …)]` in the crate yet, so the first one sets the form. `remotes/config.rs:185`, whose reason is a trailing comment, is converted like the rest.
- The completed, unarchived change `rust-unsafe-lint-and-release-profile` added the current `[lints.clippy]` table. This change extends that table and does not touch its entry.
