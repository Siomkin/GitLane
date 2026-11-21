# Proposal

## Why

`rust-typed-write-errors` introduced `WriteError` and migrated a pilot (`discard_file`, `init`). Its plan migrates the rest one module family at a time. This change takes the next two lease producers: `reset.rs` and `remotes/force_push.rs`, which author six stale-lease failures between them. Until they are typed, their kind is recovered from the message text at the IPC edge, so rewording one could silently change what the frontend sees.

There is no Jira issue. This change touches **Rust only**. No IPC, wire format, message text or frontend change.

## What Changes

- `ResetRequest::parse`, `reset_to` and `reset_branch` return `WriteError`; the two lease failures in `parse` use `WriteError::stale`.
- `force_push`, `validate_force_push_route` and their route check return `WriteError`; the four route-drift failures use `WriteError::stale`.
- Helpers they call (`head`, `operands`, `index_lock`, `hard_reset_lease`, the push transport) still return `String`. `?` wraps their text in `WriteError::Git`, which the IPC edge classifies exactly as before.
- `reset_to_oid` stays `String`: squash calls it.
- Tests pin the typed kinds: `ResetRequest::parse`'s lease failures and the force-push route drifts are `WriteError::StaleLease`.

## Non-goals

- Migrating `head.rs`, `index_lock.rs`, `hard_reset_lease`, `discard_all` or `squash_range`. They remain follow-ups.
- Removing the `String` conversions or `classify_failure`.
