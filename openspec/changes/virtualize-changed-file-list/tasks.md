# Tasks

## 1. Baseline

- [x] 1.1 Record a baseline: render `ChangedFileList` with 7,500 synthetic files over ~2,000 directories in Tree and Path view, and note the mounted row count and render time (a throwaway vitest bench or a React Profiler run in `bun run tauri dev` against a repo with an unignored `target/`)

## 2. Split before growing (no behaviour change)

- [x] 2.1 Move `DirRow`, `TreeFileRow` and their row action out of `src/features/changes/file-list/ChangedFileList.tsx` into `file-list/treeRows.tsx`; keep `ChangedFileList.test.tsx` green

## 3. Virtualize the list

- [x] 3.1 Add `file-list/useVirtualRows.ts`: find the nearest scrollable ancestor of the list ref, track the list's offset in it as `scrollMargin` (re-read on every virtualizer change including scroll, by a `ResizeObserver` on the container and its children, and by a `MutationObserver` for added or removed children), with memoized `estimateSize` / `getItemKey`, and wrap `useVirtualizer` with an exact `estimateSize` per row kind (dir 26 px; file 44/48/56 px plus the 2 px Path gap), `getItemKey` = row key, overscan 10, and an `initialRect` for the unmeasured first render
- [x] 3.2 Path view: render only `getVirtualItems()` as absolutely positioned rows at `start - scrollMargin`, with `height: size` (the 2 px gap included), inside a container of height `getTotalSize()`; drop `space-y-0.5`
- [x] 3.3 Tree view: the same over the `buildRows` output, so `DirRow` and file rows share one virtual sequence; collapse, `forceExpanded`, and the filter highlight behave as before
- [x] 3.4 Keyboard ↑/↓: map the next path to its row index and call `virtualizer.scrollToIndex(index, { align: "auto" })` instead of `querySelector(...).scrollIntoView()`

- [x] 3.5 Screen readers: `role="list"` on the list, `role="listitem"` with `aria-setsize` / `aria-posinset` on each mounted row

## 4. Linear folder guards

- [x] 4.1 `WorkingFileSection.tsx`: build a `Map<path, FileChange>` once with `useMemo` and have `dirBlocked` look up paths instead of filtering `files`
- [x] 4.2 `IncludeFileSection.tsx`: build the unstaged + staged path map once with `useMemo` and have `guardFor` look up paths instead of spreading and filtering both arrays per row
- [x] 4.3 `includeList.ts`: `rollupState` and `includeTarget` take the path → row map (`includeRowsByPath`) instead of filtering every row

## 5. Tests

- [x] 5.1 Update tests that depend on the changed helpers (`includeList.test.ts`); the inspector tests pass unchanged inside the `initialRect` window
- [x] 5.2 Add a test: 5,000 files mount a bounded number of row elements in Path and in Tree view
- [x] 5.3 Add a test: ↓ from a row outside the mounted window selects the next file
- [x] 5.4 Add a test: a folder's Stage action is disabled with its reason when one file under it is guarded, and enabled otherwise (`WorkingFileSection.test.tsx`)

## 6. Verify

- [x] 6.1 `bun check`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes`, `bun run cycles`, `bun run coverage`
- [x] 6.2 Manual check in a debug build on a repo with 7,500 untracked files in 750 folders plus 30 staged files: Path and Tree view scroll without stalls; Unstaged and Staged scroll as one page, and the Staged section sits right after the last unstaged row (f7499) with nothing overlapping; collapsing the 7,500-file folder pulls the Staged section up into place; staging the pkg-000 folder staged exactly its 10 files (checked with `git diff --cached`); ↓ ×40 walks past the visible rows and the panel follows; three files added outside the app re-synced (7,530 → 7,533) without freezing. Not checked by hand: opening the filter while scrolled down, and the selected-commit and merged-selection inspectors (covered by their tests)
- [x] 6.3 Result: in happy-dom, 7,500 files in the old list mounted 2.3 s (Tree) / 1.4 s (Path) with ~104k–112k DOM nodes, and re-selecting a row took 0.4–0.7 s; the new list mounts in 47 / 17 ms with ~500–660 nodes, and re-selecting takes 5–7 ms. In the app the panel holds about 90–125 accessibility elements at any scroll position
