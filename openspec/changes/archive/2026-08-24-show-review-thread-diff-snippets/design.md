## Context

See `proposal.md` for motivation and `specs/pull-requests/detail/spec.md` for behavior.

Thread cards already render path, line, outdated/resolved, and comments from `ReviewThread`. That type has no hunk. GitHub's review-thread query in `src-tauri/src/git/forge/threads.rs` already walks `reviewThreads` and each comment's `author/body/createdAt`, but does not request `diffHunk`. GitHub exposes `diffHunk` on `PullRequestReviewComment` (the first comment in a thread is enough; later replies share the same hunk). Origin thread DTOs have path/line/comments and no hunk field. GitLab/Bitbucket still return empty thread lists.

`ReviewThreads.tsx` is already a folder-sized module and close to the React size ratchet. File diffs already paint `ctx` / `add` / `del` in `src/features/review/` (`diffTones.ts`, `UnifiedDiff.tsx`).

## Goals / Non-Goals

**Goals:**

- Carry an optional provider hunk on the existing `ReviewThread` IPC payload (no new command).
- Paint that hunk on the card with the existing add/del/ctx tones.
- Keep GitHub as the first provider that can populate it. Origin omits the snippet unless a hunk field is already on the thread payload (it is not today).
- Split the new UI out of `ReviewThreads.tsx` so the file stays under the size ceiling.

**Non-Goals:**

- Reconstructing a hunk from local git or the Files tab when the provider omitted one.
- Widening GitLab/Bitbucket thread support.
- Reusing the full `FileDiff` / `UnifiedDiff` component (too much chrome for a card).
- A new IPC command or a second thread-fetch.

## Decisions

### Store the raw provider hunk as `diffHunk: string | null` on `ReviewThread`

Add `diff_hunk: Option<String>` to the Rust `ReviewThread` (serde camelCase `diffHunk`). Take the first comment's `diffHunk` from the GitHub GraphQL query. Empty string maps to `None`.

Why a string, not `DiffHunk`: GitHub already returns a unified-diff fragment. Parsing it into `DiffHunk` in Rust would invent a second hunk parser next to the file-diff one, for a display-only field. Parse at the paint site instead.

Alternative considered: attach `diffHunk` to every `PrComment`. Rejected because the hunk is a thread property; replies do not have their own snippet.

### Extend the existing GitHub threads query; keep one command

Add `diffHunk` to the comment selection in `REVIEW_THREADS_QUERY`. Map it in `GqlThread::into_thread`. Origin `into_thread` sets `diff_hunk: None` unless a later DTO field appears. Trait default empty thread lists stay empty.

Keep `pull_request_review_threads` as the only command. Update the four layers in lockstep: Rust type, existing command payload, `src/lib/api/github/types.ts` + `reviewThreadSchema`, UI.

### Paint in a new `ThreadDiffSnippet` next to `ThreadCard`

Add `src/features/pull-requests/ThreadDiffSnippet.tsx` plus a tiny pure parser (unified-diff lines → `{ kind: ctx|add|del|header, text }[]`). Use the same background/text tokens as `UnifiedDiff` / `diffTones`. Render under the line badge, above the comments. If `diffHunk` is null or parses to no lines, render nothing.

Do not import `UnifiedDiff` or `FileDiff`. Those assume a full file review (headers, hunk actions, split view).

Alternative considered: append the snippet into `ThreadCard` in `ReviewThreads.tsx`. Rejected because that file is already large and the snippet is a real seam.

### Tests follow current vitest style

- Parser unit tests: header, add, del, ctx, empty, no-prefix garbage.
- `ReviewThreads` / `ThreadCard` tests: snippet present when `diffHunk` is set; omitted when null; no editor controls.
- API schema fixture: a thread with `diffHunk` still validates.
- Rust: GitHub DTO maps first-comment `diffHunk`; missing field is `None`.

## Risks / Trade-offs

- [GitHub hunks can be long] → Render the provider fragment as-is; do not fetch extra context. Cards already scroll with the discussion column.
- [Origin has no hunk field today] → Origin cards omit the snippet. Do not guess from path/line. Revisit when Origin exposes one.
- [Parser disagrees with a weird fragment] → Fall back to omitting the snippet rather than showing a broken card. The rest of the thread still renders.
- [Schema lockstep] → `assertEqual` in `schemas.ts` will fail until types and zod stay together; that is the intended guard.

## Migration Plan

No data migration. Existing thread cache in the pulls store refreshes on the next `loadPrThreads`. Rollback is revert; older clients ignore an extra field only if they do not validate — GitLane validates, so ship type + schema + UI together.
