# Design

## Context

See proposal.md, "Why". These fixes touch many modules, but none of them changes an engine, an IPC signature or a store:

- The checkout retry still moves refs through the git CLI (`move_local_ref` / `align_equivalent_sibling` under `git/write/`).
- The squash precondition still reads through libgit2.
- The OAuth parses stay in `git/oauth/`, behind its `HttpTransport` trait.
- `checkout_remote_branch` keeps its signature (`Result<String, String>`). `From<String> for CommandError` (`classify::classify_failure`) still classifies the text, so the TS wrapper and its types don't change.
- No Zustand store changes.

Two facts the decisions below rely on:

- **Errors are already redacted.** Git's stderr is redacted at the subprocess boundary (`git/write/cli/finish.rs`), so the error `advance_local_branch` returns is already clean when the checkout wraps it.
- **The suffix decides the error kind.** `classify_failure` classifies any text containing `STALE_SUFFIX` ("Refresh and try again.") as `StaleLease`, after the auth, network and index-lock checks (`classify.rs:160-166`). `classify/tests.rs` pins every "again" literal under `write/` to that kind.

CI runs clippy with `-D warnings` on the default build and on `--no-default-features --features agent`, plus a weekly Windows job (`ci.yml:508-528`). A lint added to `[lints.clippy]` therefore blocks all three runs.

## Goals / Non-Goals

**Goals:**
- Every error path this change touches keeps a cause someone can diagnose, without ever adding response bytes or credentials to a message.
- Every lint this change adopts passes clean in every configuration CI builds on the day it lands. No `#[allow]` is added just to get there.

**Non-Goals:** see proposal.md, "Non-goals". The size ceiling doesn't come into play: the largest file touched, `branch_checkout.rs` (283 lines), sits in the look band and gains only a few lines, so no split is due.

## Decisions

### 1. Checkout retry: wrap the second error, keep it a stale lease

`branch_checkout.rs:101` becomes `.map_err(|error| retry_failure(&remote_ref, branch, &error))`. `retry_failure` is a private helper:

```rust
classify::stale(&format!(
    "{remote_ref} changed while {branch} was being checked out, and the retry failed: {}",
    error.trim_end().trim_end_matches('.'),
))
```

- **Why `stale(...)`:** the message today is a stale lease, and the frontend's refresh-and-retry handling depends on that. The suffix keeps it there. An auth, network or index-lock failure inside `error` is still caught first by those earlier checks, which is correct.
- **Why trim:** it avoids a double period ("File exists.. Refresh") when git's own text ends in a period.
- **Alternative rejected:** returning the bare `error`, as the first-attempt path at line 98 does. It drops the hint that a concurrent fetch was involved, and it reclassifies the failure as `Git`.
- **Testability:** reaching the retry branch in an integration test means moving the remote ref between classification and the first update, which a fixture cannot schedule reliably. So `retry_failure` is a pure function, unit-tested for three things:
  - it contains the remote ref and the inner error;
  - it classifies as `StaleLease`;
  - an inner error that already carries a redaction marker comes through unchanged (spec scenario 2).

  The integration case with a held `refs/heads/<branch>.lock` covers the first-attempt path. It locks in that git's own text reaches the user; it does not exercise the retry.

### 2. OAuth parse errors: category and position, never `Display`

`serde_json::Error`'s `Display` can quote the value it failed on, and these bodies carry device codes and access tokens. A helper in `git/oauth/` builds the detail from fields that never hold response bytes:

```rust
parse_detail(e: &serde_json::Error) -> String
// → "({:?} at line {}, column {})" from e.classify(), e.line(), e.column()
```

The existing friendly sentence is kept, with the detail appended.

- **Who sees it:** the text is user-visible, not only logged. That is acceptable because it contains nothing but a category and a position.
- **Alternative rejected:** `redact_secrets(&e.to_string())`. Redaction is pattern-based, and a device code or an opaque token need not match any pattern.
- **Test design:** a passing test must fail if the implementation leaks. Each test puts the secret at a spot where serde would quote it, such as a string where `DeviceCodeDto` expects a number, or a string where the identity DTO expects `id: u64`. It asserts that `e.to_string()` does contain the secret and that the returned message does not.
- **`TokenDto` (exchange):** it has only `Option<String>` fields, so it cannot quote a secret on a type error. Its test covers malformed JSON only.

### 3. Squash precondition: tell "gone" apart from "unreadable"

`squash_range/target.rs:7` matches on `e.code() == git2::ErrorCode::NotFound`:

- `NotFound` keeps "Target branch changed or was deleted…";
- anything else returns `"Could not read refs/heads/{branch}: {e}"`.

This is a local ref read, and libgit2 errors carry no remote credentials. Driving the unreadable branch in a test needs a malformed loose ref file (for example, garbage in `refs/heads/<branch>`). If libgit2 reports that as `NotFound` on some platform, the helper is split so the mapping can be tested on a constructed `git2::Error`.

### 4. Panic and cast cleanups, each a one-liner

| Site | Change |
|---|---|
| `watcher.rs:66` | `Instant::now().checked_sub(THROTTLE).unwrap_or_else(Instant::now)` |
| `forge/diff/path.rs:91` | `u8::try_from(val).unwrap_or(u8::MAX)` |
| `agent/protocol.rs:88-96`, `build.rs:17` | `unwrap()` → `expect("…")`, stating the invariant the comment already gives |

- **Clamping to 255 is an arbitrary choice.** Git never emits an escape above `\377`, so real input is unaffected. The clamp only replaces silent wrapping, where `\400` became byte 0, with a visible substitute byte on crafted input. `U+FFFD` was considered, but this function builds bytes before a lossy UTF-8 decode, and a single byte is the natural unit here.

### 5. Lint subset and `clippy.toml`

Add to the `[lints.clippy]` table in `src-tauri/Cargo.toml`, keeping the existing `undocumented_unsafe_blocks = "deny"` line:

```toml
unwrap_used = "warn"
allow_attributes_without_reason = "warn"
unchecked_time_subtraction = "warn"
```

Add a new `src-tauri/clippy.toml` containing `allow-unwrap-in-tests = true`. All three lints exist on the pinned 1.100.0 toolchain.

- **Coverage gap:** clippy's `allow-unwrap-in-tests` recognises only a bare `#[cfg(test)]`. Test code under `cfg(all(test, …))` still fires, and that is 15 sites:
  - `smoke.rs` (desktop build only);
  - `state_lease/golden_fixture.rs`;
  - `hard_reset_lease/golden_tests.rs` and `discard_all/golden_tests.rs`;
  - `worktree_fs/tests.rs`;
  - test code in `write/cli.rs`.

  These switch to `expect("…")`. Re-gating the modules under a bare `#[cfg(test)]` was rejected, because the extra conditions (`unix`, `feature = "desktop"`) are real.
- **Why `warn`, not `deny`:** CI's `-D warnings` already makes these lints blocking, and `warn` keeps a local `cargo check` usable while an edit is half-done.
- **`map_err_ignore` rejected:** see proposal.md, "Non-goals".

### 6. `#[allow]` reasons

All 21 reason-less sites get `reason = "…"`. A `cfg_attr` form keeps its condition: `#[cfg_attr(windows, allow(dead_code, reason = "…"))]`.

- **Inner `#![allow(clippy::result_large_err)]`:** `agent.rs:9`, `remote.rs:7`, `commands/mod.rs:13`, `git/forge.rs:46`.
- **Outer `#[allow]`:**
  - `credentials.rs:135`, `provider_tokens.rs:45,103`;
  - `patch_staging/extract.rs:121`, `commands/registration_tests.rs:270`;
  - `remotes/config.rs:185` (its trailing comment becomes the reason).
- **`cfg_attr` forms:**
  - `shell.rs:24,220,295`, `credentials.rs:339`;
  - `state_lease.rs:64`, `graph/layout/build.rs:67`, `forge/service.rs:31`;
  - `lib.rs:15` (multi-line, agent-only).
- **Test support:** `git/write/tests/support.rs:2`, `acp/session/tests/support.rs:3`.
- **`forge/dto/head_ref.rs:47`** keeps `allow`, now with a reason, rather than becoming `#[expect]`. `#[expect(dead_code)]` turns into an error in any configuration where the field happens to be read, and it would have to hold in all four builds (lib and test, desktop and agent). For one serde field, that cost outweighs the benefit.

Some sites compile only on Windows or only on non-unix, so local clippy on macOS cannot see them. A grep over `src/` and `build.rs` (task 5.2) is therefore the cross-platform check.

## Risks / Trade-offs

- **[Risk]** A test helper compiled outside `cfg(test)` still trips `unwrap_used`. → **Mitigation:** tasks 6.2–6.4 run clippy and the tests in both feature sets.
- **[Risk]** The Windows-only `cfg_attr` sites can't be checked locally. → **Mitigation:** the grep in task 5.2 checks every `allow(` regardless of platform, and the weekly Windows clippy job is the backstop.
- **[Trade-off]** The OAuth detail ("Syntax at line 1, column 42") is terse and user-visible. That's acceptable: it is enough for support and can never leak a token.
