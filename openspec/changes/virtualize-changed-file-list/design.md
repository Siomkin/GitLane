# Design

## Context

Engine: none. This is a frontend rendering change. It touches no IPC command,
no Rust code, and no Zustand store. The data is the same `FileChange[]` that
`WorkingInspector`, `CommitInspector`, and `MergedSelectionInspector` already pass
to `ChangedFileList`.

How the list renders today:

- **Path view:** one `FileRow` per file in a `space-y-0.5` stack. A row is `h-11`
  when compact, `h-12` for the taller working-changes rows, and `h-14` when the
  file carries an `advanced` notice.
- **Tree view:** `buildRows` (`commitTree.ts`) flattens the tree into
  `dir` and `file` rows. A `DirRow` is `h-[26px]`, and file rows use the compact
  height.
- **Scrolling:** `ChangedFileList` has no scroll container of its own. Each
  inspector wraps its title, filter, and one or more lists in a single
  `overflow-auto` div. Working Changes shows Unstaged and Staged one after the
  other inside that div.
- **Keyboard:** ↑/↓ finds the next row with
  `querySelector([data-path])` and calls `scrollIntoView`.
- **Folder guards:** `WorkingFileSection.dirBlocked(paths)` and
  `IncludeFileSection.guardFor(paths)` filter the whole file list for each
  directory row. That makes a render cost O(directories × files).

`ChangedFileList.tsx` is 338 lines, inside the 201–400 "look" band. The new
virtualization code would push it close to the 400-line hard ceiling.

## Goals / Non-Goals

**Goals:**

- Mount only the rows near the viewport, in both views, for every inspector
  that uses `ChangedFileList`.
- Keep the shared scroll: the inspector's header and its sections scroll as one
  page, as they do now.
- Make the cost of the folder guard linear in the number of files.
- Keep selection, the context menu, filter highlight, collapse, `forceExpanded`,
  and the row and folder actions working as they do now.

**Non-Goals:**

- Changing what the backend reports for untracked files (see the proposal).
- Giving each section its own nested scroll box.

## Decisions

### Virtualize inside the inspector's existing scroll container

Each `ChangedFileList` gets its own `useVirtualizer`. It uses the inspector's
`overflow-auto` div as `getScrollElement` and sets `scrollMargin` to the list's
offset inside that div. This is TanStack Virtual's documented way to virtualize
a list that is not the first thing in its scroller. It lets two lists (Unstaged
and Staged) share one scrollbar.

The scroll element is found once on mount by walking up from the list's own ref
to the nearest scrollable ancestor. A small helper next to the list does this.
Doing it this way means none of the three inspectors needs a new prop. The
alternative, threading a `scrollRef` prop through `FileSection` and
`IncludeFileSection` from each inspector, was rejected because it adds plumbing
to five call sites for no behaviour gain.

`scrollMargin` must follow layout changes above the list: the filter field
opening, the Unstaged section growing or shrinking, a notice appearing. The
list therefore re-reads its offset when a `ResizeObserver` sees the scroll
container or any of its direct children resize, and when a `MutationObserver`
sees a child added or removed (the filter field opening). If it does not, the
second section's window drifts.

Rejected: give each section a fixed-height scroll box. That changes the layout
the user sees (two small scrollbars instead of one page) and breaks the
"sections scroll together" behaviour.

### Row sizes come from the row model

`estimateSize(index)` returns the exact height for the row's kind:
`DirRow` 26 px; a file row 44/48/56 px plus the 2 px Path-view gap. Every row
height is a fixed CSS class, so the estimate is exact and rows are not measured
(the same choice as `HistoryWorkspace`). `measureElement` was tried and dropped:
in happy-dom every row measures 0 px, which makes the virtualizer re-render
without end. Each row wrapper is absolutely positioned at
`start - scrollMargin` with `height: size`. The Path view's `space-y-0.5` gap is
part of that size, because absolutely positioned rows ignore sibling margins.

`getItemKey` returns the row key: the file path, or the directory key in Tree
view. Keeping keys stable stops collapse toggles and re-syncs from remounting
every visible row.

Overscan is about 10 rows, so a fast scroll or wheel flick does not show blank
space.

### Keyboard navigation goes through the virtualizer

`navigate` keeps its logic for choosing the next path. It maps that path to its
row index and calls `virtualizer.scrollToIndex(index, { align: "auto" })`. This
replaces the `querySelector` and `scrollIntoView` pair, which finds nothing once
the target row is unmounted. Focus stays on the list, as it does today.

### Folder guards from a path map

In both `WorkingFileSection` and `IncludeFileSection`, build a
`Map<path, FileChange>` once per render with `useMemo` over the section's files.
`dirBlocked(paths)` and `guardFor(paths)` then look up each path and pass the
result to `findGuardedFile`. The cost becomes O(files under that folder), and
only for folder rows that are actually mounted, because `dirAction` is only
called for rendered rows once the list is virtualized.

`IncludeFileSection` builds a path → `FileChange[]` map over
`[...changes.unstaged, ...changes.staged]` once, instead of spreading both
arrays for every row; a partly staged file keeps both entries. `rollupState`
and `includeTarget` (`includeList.ts`) take the existing `byPath` row map instead
of filtering every row, because the Include view calls them for each folder and
each file row.

### Split ChangedFileList while touching it

`ChangedFileList.tsx` already lives in the `file-list/` folder module.
`DirRow`, `TreeFileRow` and their row action move to `file-list/treeRows.tsx`, and the virtualization glue (finding
the scroll parent, the offset, the size estimate) goes into
`file-list/useVirtualRows.ts`. That keeps every file under 200 lines and stops
the list from crossing the 400-line ceiling. No behaviour changes in the move.

### No store change

The collapse state stays local to the list (`useState`). Selection stays in each
caller's store. No module needs a store split.

## Risks / Trade-offs

- **Tests in happy-dom have no layout.** A virtualized list in happy-dom renders
  only the `initialRect` window, so existing tests that look for a file row by
  name may fail. Mitigation: pass `initialRect` (as `HistoryWorkspace` does) with
  a height large enough to render the few rows those tests use. Add one test that
  renders thousands of files and asserts that only a bounded number of rows
  mount.
- **The `scrollMargin` can drift.** If the offset is not refreshed when content
  above the list changes size, rows render at the wrong place. Mitigation: refresh
  the offset on resize, and cover it with a manual check that opens the filter and
  stages files while scrolled down.
- **Find-in-page (⌘F) cannot find unmounted rows.** The webview's find already
  plays little role in this panel, and the panel's own filter field searches
  every file. This is accepted.
- **Overall gain depends on the backend too.** A re-sync of 7,500 untracked files
  still pays for the Rust status walk and the IPC payload. This change removes the
  render cost, which is what freezes the panel. If the walk itself proves slow,
  that is a separate change (see the proposal's non-goals).
