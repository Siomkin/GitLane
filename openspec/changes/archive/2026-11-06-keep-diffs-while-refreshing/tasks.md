# Tasks

## 1. Cache: revalidate without blanking (`src/hooks/useLazyDiffs.ts`)

- [x] 1.1 Add a `stale` ref (`Set<string>`) and a `revalidate()` callback that bumps `gen`, clears `inflight`/`queue`/`queued`, and marks every settled key stale without touching `diffs`; return it from the hook. Verify `bun check` passes.
- [x] 1.2 Make `ensure()` and `pump()` treat a stale key as not cached; on a current-generation success or failure, write the value and delete the key from `stale`; have `reset()` and `evict()` clear `stale` for their keys. Update the hook's doc comment to describe both reset modes. Verify with 1.3.
- [x] 1.3 Add `src/hooks/useLazyDiffs.revalidate.test.tsx` covering: a value survives `revalidate()` and is replaced by the refetch; `ensure()` refetches a stale key; a result from before `revalidate()` is dropped; a failed refetch replaces the stale value with `null`; `reset()` still clears everything. Verify `bun run test src/hooks/useLazyDiffs` passes, existing tests included.

## 2. Changes review uses revalidate (`src/features/changes/changes-workspace/useWorkingTreeDiffs.ts`)

- [x] 2.1 Split the reset effect: a repo change calls `reset()`, a same-repo `changes` change calls `revalidate()`; make sure the hard reset wins when both change in one render; keep both effects above the fetch effect and update the GL-173 comment. Verify with 2.2.
- [x] 2.2 Extend `ChangesWorkspace.test.tsx`: after a same-repo snapshot, an expanded file's previous diff stays rendered (no "Loading diff…") and the new diff replaces it once the refetch resolves; the existing GL-173 tests (identical-counts refetch, repo switch never reuses a same-path diff) still pass. Verify `bun run test src/features/changes` passes.

## 3. Integration checks

- [x] 3.1 Run the `verify` agent (`bun check`, `bun run test`, `bun run build`, `bun run sizes`, `bun run cycles`) and confirm every check exits 0.
- [x] 3.2 In `bun run tauri dev`, open Review all with several files expanded, tick a file's checkbox, and confirm the other open diffs don't flash "Loading diff…". Also confirm the stacked review still clears when switching commits.
