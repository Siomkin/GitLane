# Design

## Context

`useLazyDiffs` (`src/hooks/useLazyDiffs.ts`) is a keyed diff cache with a bounded fetch window
and a generation guard. Its `reset()` bumps the generation, clears the queue and in-flight
markers, and empties both `cacheRef` and the `diffs` state. Two callers:

- `useWorkingTreeDiffs` calls `reset()` whenever `changes` or `repoPath` changes. Its keys
  (`diffKey`: source, path, status, add, del) only tell files apart within one snapshot, so
  each new snapshot has to refetch (GL-173).
- `StackedReview` calls `reset()` when the reviewed commit changes. Its keys are paths within
  that commit.

`ReviewFileSection` shows "Loading diff…" whenever `diffs[key] === undefined`, so emptying the
state is what blanks the open diffs. No Zustand store is involved; nothing crosses IPC.

## Goals / Non-Goals

**Goals:** a same-repo snapshot keeps each shown diff until its refetch settles. The generation
guard and the bounded window behave exactly as today.

**Non-Goals:** changing `reset()` semantics, `StackedReview`, the watcher, or the store's
refresh/publish path.

## Decisions

### D1. Add `revalidate()` next to `reset()`; don't change `reset()`

`revalidate()` does everything `reset()` does (bump `gen`, clear `inflight`/`queue`/`queued`),
but keeps the settled entries in `diffs`, marking each kept key **stale** in a ref
(`stale: Set<string>`). `reset()` stays the hard clear.

*Alternative:* make `reset()` keep stale values for everyone. Rejected: in `StackedReview` a
kept value would be the previous commit's diff under the same path key, which would be wrong.
The repo-switch case has the same problem (same path, other repo).

### D2. Stale entries count as missing for fetching, present for display

- `ensure()` and `pump()` skip a key only when it is cached **and not stale**. Today's check,
  `cacheRef.current[key] !== undefined`, becomes "has a fresh value".
- A current-generation result (success or `null` failure) replaces the value and removes the
  key from `stale`. An invalidated generation's result is still dropped, as today.
- `diffs` keeps the stale value, so the caller's `diffs[key] === undefined` loading check
  holds without changes.
- `evict()` also deletes the key from `stale`.

A stale key that is no longer requested (its file collapsed, or its key changed because
status/counts moved) just stays in the map until the next `reset()`/`evict()`, the same
lifetime settled entries have today. Re-expanding it later shows the stale diff and refetches,
which is correct because every displayed diff gets revalidated.

### D3. `useWorkingTreeDiffs` chooses per trigger

Split the single effect: `[repoPath]` → `reset()` (hard, spec "Switching repositories");
`[changes]` → `revalidate()`. The effect order still runs before the fetch effect, so open
files re-`ensure` in the same pass. On a repo switch both effects run, and the hard reset must
win: run `reset()` after `revalidate()`, or skip `revalidate()` when the repo changed (track the
previous repo in a ref).

### D4. A failed refetch replaces the stale diff with "Couldn't load diff."

A refetch that fails stores `null`, as today. Keeping a stale diff on failure would hide a real
read error behind outdated content.

## Risks / Trade-offs

- [Briefly outdated diff on screen after an outside edit] → it's replaced as soon as the
  refetch lands (one IPC round trip). The spec allows this explicitly.
- [Stale key reused after a staged/unstaged flip] → can't happen: `diffKey` includes the
  source, so a flipped file has a new key with no value and shows loading.
- [Size ceiling] → `useLazyDiffs.ts` is 165 lines and stays well under 400.
  `useLazyDiffs.test.ts` is 360 lines, so put the new tests in
  `src/hooks/useLazyDiffs.revalidate.test.tsx` (`.tsx` so it lands in the DOM test project
  without an allowlist entry) rather than pushing it toward the limit.
