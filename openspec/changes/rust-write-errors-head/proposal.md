# Proposal

## Why

`rust-write-errors-reset-force-push` typed the leases reset and force-push author themselves, but the ones users hit most at runtime come from `git/write/head.rs`: a branch tip that moved, a HEAD that changed branch, or a HEAD that gained a commit. About twenty write paths guard on these (reset, force-push, merge, rebase, cherry-pick, revert, fast-forward, squash, pull, push, stash, worktree hand-off). Their kind is still recovered from the "Refresh and try again." text at the IPC edge.

There is no Jira issue. This change touches **Rust only**. No IPC, wire format, message text or frontend change.

## What Changes

- `ensure_revision_at`, `ensure_expected_head`, `ensure_expected_branch_tip` and `checkout_expected_branch` return `WriteError`. Their three lease failures use `WriteError::stale`, which appends the same suffix, so the text is unchanged.
- `ensure_commit_exists`, the switch helpers and `current_branch` stay as they are: they report git's own failures, not leases.
- `reset`'s `prepare_hard_reset_subject` returns `WriteError` (reset is already typed).
- The untyped callers keep returning `String`; `?` converts the typed error back to the same text, which the IPC edge classifies as a stale lease as before.
- `tests/error_kinds.rs` pins a reset of a branch whose tip moved: typed `WriteError::StaleLease` at the source, and the exact `CommandError` that crosses IPC.

## Non-goals

- Migrating the callers of these helpers; each family keeps its own follow-up.
- Typing `ResetSubject::parse`'s "no expected commit" message, `index_lock`, `hard_reset_lease`, `discard_all` or `squash_range`.
