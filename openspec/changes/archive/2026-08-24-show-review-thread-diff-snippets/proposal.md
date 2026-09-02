## Why

Review-thread cards already show the file, line, outdated/resolved badges, and comments, but not the code they are anchored to. Users have to leave GitLane to understand a comment. `ReviewThreads.tsx` already names the inline hunk as the planned follow-up.

There is no Jira key for this change.

## What Changes

- Show a read-only anchored diff snippet on each review-thread card when the provider supplies one.
- Carry that snippet through the existing review-threads IPC (extend `ReviewThread`, do not add a new command).
- Fetch GitHub's comment `diffHunk` on the current threads query. Include Origin when the Origin thread payload already has an equivalent hunk; otherwise Origin cards omit the snippet.
- When no hunk is available (missing field, unanchored/outdated thread, GitLab/Bitbucket empty thread lists), omit the snippet. Do not reconstruct one from the local diff.
- Keep discussion read-only. No comment, reply, or request-changes controls.

## Capabilities

### New Capabilities

- None. This extends an existing capability.

### Modified Capabilities

- `pull-requests/detail`: A review thread that has an anchored hunk SHALL show that snippet on the card; a thread without one SHALL still show the rest of the card.

## Impact

- Processes: Rust forge thread fetch/DTO/types, typed IPC payload, frontend zod schema, and `ReviewThreads` UI.
- Existing patterns: extend `git/types/forge.rs` `ReviewThread` and the current `REVIEW_THREADS_QUERY` in `git/forge/threads.rs`; render the snippet next to `ThreadCard` using the existing review/diff line coloring (`ctx` / `add` / `del`), not a new diff engine.
- IPC: no new command. Widen `pull_request_review_threads` / `ReviewThread` only. Keep the four layers in lockstep (Rust type, command payload, `src/lib/api` types + schema, UI).
- Auth/secrets: none. Provider tokens stay backend-only. The snippet is provider-supplied display text, not a secret.
- Dependencies: none.

## Non-goals

- GitLab or Bitbucket review threads (those providers still return an empty list).
- Re-adding in-app comments, replies, or request-changes.
- Showing a full file diff, or scrolling the Files tab to the hunk.
- Reconstructing a hunk from local git when the provider omitted one.
- Customizing keyboard shortcuts or PR sidebar editing.
