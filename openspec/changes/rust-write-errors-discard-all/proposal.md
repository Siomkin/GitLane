# Proposal

## Why

Discard all is the last lease family on the write path. Its stale failures ("The working tree changed after this confirmation opened.", plus the nested-repository cases) are still recovered from the "Refresh and try again." text at the IPC edge. Worse, its mutation-boundary re-capture decides control flow from text: it compares the error to a drift constant and checks `error.ends_with(STALE_SUFFIX)` to tell drift from a failed capture.

There is no Jira issue. This change touches **Rust only**. No IPC, wire format, message text or frontend change.

## What Changes

- The facade's `STALE_MESSAGE` constant becomes `lease::stale_lease()`, a `WriteError::stale` with the same text. The two nested-repository failures use `WriteError::stale` too.
- The mutation path returns `WriteError`: `discard_all`, `validate_repository_scope`, `validate_head_lease`, `validate_observations`, `capture_once`, `capture_stable`, `recapture_at_mutation_boundary`, the tracked recaptures, `cleanup_paths`, `reject_tracked_paths_in_nested_repositories` and `digest_tracked_from_captured`.
- `recapture_at_mutation_boundary` no longer reads text. A private `StableCapture { Drift, Failed }` from `capture_twice` carries "the two passes disagreed". Drift and a `StaleLease` prove the lease expired. Any other failure becomes "Could not re-check the working tree, so nothing was discarded. …", as before.
- Messages that are not leases become `WriteError::Git` with unchanged text. That covers the partial-cleanup reports, the tracked-recheck drift, the preview's refusals and git's own output.
- `preview_discard_all` stays `String`; `?` converts the typed error back to the same text.
- `tests/error_kinds.rs` pins a Discard all after the tree changed: typed `WriteError::StaleLease` at the source and the exact `CommandError`.

## Non-goals

- `index_lock` (its failures are git's own stderr) and `squash_range` (no leases).
- Removing the `String` conversions or `classify_failure`.
