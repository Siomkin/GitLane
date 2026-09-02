## 1. Inspector parent picker

- [x] 1.1 Show every parent on a non-stash merge in `CommitInspector` (short sha + ref name when a branch/tag points at that parent), defaulting to parent 0, and verify a two-parent fixture renders both while a single-parent commit still shows one unlabeled parent
- [x] 1.2 Hide the picker for stash commits and verify the existing stash inspector test still lists the stash union without parent buttons

## 2. File list and hunks follow the selected parent

- [x] 2.1 Store inspect-against-parent index on `useRepo` (reset to 0 on commit change) and load parent 0 via `commitFiles` / `commitFileDiff`; verify existing first-parent inspector tests still pass
- [x] 2.2 On parent index > 0, load `diffRange(parentOid, mergeOid)` / `diffRangeFile` and verify a merge whose first-parent list is large and second-parent list is the feature scope (many files vs the mainline parent) swaps the Changed files count when the second parent is selected
- [x] 2.3 Point “Review all” at `compareRange(parentOid, mergeOid)` when a non-first parent is active and verify stacked review opens that range, not a first-parent commit review

## 3. Definition of done

- [x] 3.1 Run `bunx tsc --noEmit`, `bun run lint`, `bun run test` on the touched inspector/selection files, `bun run sizes`, and `openspec validate fix-merge-inspect-parent-diff --store gitlane`, and verify they pass
- [x] 3.2 In `bun run tauri dev`, select a “merge mainline into my feature” commit: default list is the large first-parent set; choosing the mainline parent shows only the feature’s own files — without a new IPC command
