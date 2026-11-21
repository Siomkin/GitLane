# Proposal

## Why

After `rust-write-errors-head`, the last untyped lease on the hard-reset path is the worktree lease in `git/write/hard_reset_lease/`. It fails with "The repository changed after this confirmation opened." when the index, worktree or HEAD drifted since the confirmation. Its kind is still recovered from the "Refresh and try again." text at the IPC edge, and `reset_branch` (already typed) is its only mutation-boundary caller.

There is no Jira issue. This change touches **Rust only**. No IPC, wire format, message text or frontend change.

## What Changes

- `scope.rs`'s `STALE_MESSAGE` constant becomes `stale_lease()`, which returns `WriteError::stale` with the same text.
- `validate_at_mutation_boundary` and the observation recheck `validate_observations` return `WriteError`, and their drift failures use `stale_lease()`.
- A re-capture that fails outright keeps its "Could not re-check the repository state…" wording as `WriteError::Git`: it is not proof of drift.
- The preview capture (`capture`, still `String`) converts the recheck's typed error back to the same text with `?`.
- `tests/error_kinds.rs` pins a hard reset after the index changed: typed `WriteError::StaleLease` at the source and the exact `CommandError` that crosses IPC.

## Non-goals

- `discard_all` and `worktree_removal_lease`, which have their own stale constants, plus `index_lock` and `squash_range`.
- Typing the rest of `hard_reset_lease` (`capture`, `ensure_source_is_checked_out`).
