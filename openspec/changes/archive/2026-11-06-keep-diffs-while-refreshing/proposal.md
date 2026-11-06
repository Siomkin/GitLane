# Proposal

## Why

In the Changes tab's multi-file review ("Reviewing N changed files"), ticking a file's
checkbox makes every other open diff blink twice: each one is swapped for "Loading diff…" and
then redrawn. One click produces two working-tree snapshots: the stage action's own refresh,
then the watcher's quiet re-sync after `.git/index` changes. Every new snapshot empties the
review's diff cache (GL-173), so every open diff disappears until its refetch lands. The same
blink happens on any watcher or focus refresh while the review is open.

There is no Jira issue for this.

## What Changes

- When a new working-tree snapshot arrives for the **same repository**, the multi-file review
  keeps showing each open file's current diff while it refetches, and swaps in the new diff
  when it lands. "Loading diff…" only appears for a file that has no diff on screen yet (first
  expand, or a file whose status or line counts changed).
- The GL-173 guarantee stays: every new snapshot still refetches each open file. A diff from
  an earlier snapshot is never kept once the new result arrives, and a result from an
  invalidated fetch never overwrites a newer one.
- Switching repositories still clears the cache outright, so a same-named path in the next
  repo never shows the previous repo's diff.
- The stacked review keeps clearing its cache when the reviewed commit changes. Its keys are
  per-commit paths, so an old diff there would belong to the wrong commit.

## Capabilities

### New Capabilities

- `changes/multi-file-review`: the Changes tab's multi-file staging review: how its open diffs
  behave when the working tree is re-read.

### Modified Capabilities

None.

## Impact

- Frontend only. No Rust, IPC, store, or secret/auth surface is touched.
- `src/hooks/useLazyDiffs.ts`: gains an opt-in "revalidate" path next to the existing
  `reset()`; `reset()` keeps its current meaning for the stacked review and repo switches.
- `src/features/changes/changes-workspace/useWorkingTreeDiffs.ts`: uses revalidate for
  same-repo snapshots and reset for a repo switch.
- Pattern to copy: the generation guard already in `useLazyDiffs` (GL-172/GL-173).

## Non-goals

- Suppressing the watcher's echo of GitLane's own writes, or merging the two refreshes into
  one. That is global timing and would still leave one blink.
- Skipping a snapshot whose file list looks unchanged: status and counts don't show that
  content is unchanged (GL-173).
- Changing the stacked review, the single-file review, or the right-panel inspector.
- A visual "refreshing" indicator on stale diffs.
