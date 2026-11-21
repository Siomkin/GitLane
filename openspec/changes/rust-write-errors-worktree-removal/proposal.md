# Proposal

## Why

Removing a linked worktree, and the worktree hand-off, re-check a removal lease right before they mutate. When it fails ("The worktree changed after this confirmation opened."), its kind is still recovered from the "Refresh and try again." text at the IPC edge. `worktree_removal_lease.rs` already separates real lease loss (`CaptureFailure::Stale`) from other capture failures, so the type only has to carry that distinction past the module boundary.

There is no Jira issue. This change touches **Rust only**. No IPC, wire format, message text or frontend change.

## What Changes

- `validate_removal_lease` returns `WriteError`. A foreign lease token, a lease mismatch, and a re-capture that reports `CaptureFailure::Stale` become `WriteError::StaleLease`. `CaptureFailure::Other` becomes `WriteError::Git`.
- The re-capture message keeps its order, the stale message followed by the cause, so its text is unchanged. `WriteError::StaleLease`'s doc now says the message *contains* the suffix rather than ending with it.
- `STALE_MESSAGE` becomes private to the module.
- `preview_remove_worktree` and the `worktrees/lifecycle.rs` callers stay `String`; `?` converts the typed error back to the same text.
- `tests/recovery/worktree_lease.rs` asserts the variants instead of re-classifying the text. `tests/error_kinds.rs` pins a foreign lease token: typed `WriteError::StaleLease` and the exact `CommandError`.

## Non-goals

- `discard_all`, `index_lock` and `squash_range`.
- Typing the preview's capture failures (for example the prunable-worktree message).
