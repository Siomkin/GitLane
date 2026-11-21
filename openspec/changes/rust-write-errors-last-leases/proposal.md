# Proposal

## Why

The lease migration (#638, #642–#647) typed every lease family, but three modules in `git/write/` still build stale-lease failures with the old `classify::stale` helper. Their kind is recovered from the "Refresh and try again." text at the IPC edge, so rewording one can silently change what the frontend sees. Typing them retires `classify::stale` as a producer in `git/write/`.

There is no Jira issue. This change touches **Rust only**. No IPC, wire format, message text or frontend change. Specs are skipped: it is a pure refactor with no behaviour change.

## What Changes

- **Branch delete** (`branches/delete.rs`): `ensure_branch_ref_is_direct` ("… became a symbolic ref.") and `delete_branch` return `WriteError`, with the failure built by `WriteError::stale`.
- **Patch staging** (`patch_staging/`): eight stale failures in `extract.rs` and `range.rs` ("That hunk/line is no longer available.", "… changed on disk."). The extractors, `find_hunk` and the four entry points `apply_hunk`, `apply_line`, `apply_line_range` and `revert_line_range` return `WriteError`. `find_hunk`'s "Patch-level staging is unavailable for this file" is not a lease and stays `WriteError::Git`.
- **Remote checkout** (`branch_checkout.rs`): `retry_failure` ("… changed while … was being checked out, and the retry failed: …") returns a `WriteError::stale`, and `checkout_remote_branch` returns `WriteError`.
- Callers that still return `String` (`recovery/branches.rs`, `worktrees/lifecycle.rs`) keep it and convert with `?`, as the earlier families did.
- `tests/error_kinds.rs` gets one end-to-end pin per family: the typed variant at the source and the exact `CommandError` that crosses IPC.

Copy the pattern from `git/write/head.rs` and `git/write/remotes/force_push.rs` (#642, #643).

## Decisions

- `retry_failure` embeds git's own `update-ref` error as the cause. Today it classifies as a stale lease because the text-classifier checks index-lock, auth and network patterns first, and `update-ref` produces none of them (a ref lock is `<ref>.lock`, not `index.lock`). Typing it as `StaleLease` therefore keeps the kind. The existing test `retry_failure_classifies_as_a_stale_lease` becomes a variant assertion.
- `range.rs` matches `find_hunk(..)` with `Err(_) => break` to find the end of the hunk list. That control flow ignores the error's content, so it is unchanged by typing.

## Risks

- None for secrets, auth or IPC: no credential parameter, command signature or wire type changes. The four staging commands and `delete_branch`'s command already accept any `E: Into<CommandError>` through `blocking`.
- `patch_staging/extract.rs` (363 lines) and `branch_checkout.rs` (362) sit in the 251–400 look band. The edits only change return types and constructors and must not push either past 400 (`bun run sizes`).

## Non-goals

- `index_lock` (its failures are git's own stderr) and `squash_range` (no leases).
- Removing `classify::stale`, the `String` conversions or `classify_failure`. Tests and untyped callers still use them.
- Typed errors outside `git/write/`.
