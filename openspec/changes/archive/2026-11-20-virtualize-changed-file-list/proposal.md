# Proposal

## Why

The right-hand file panel freezes when a change touches thousands of files. A
repository with an unignored build directory (for example a Cargo `target/`)
showed 7,542 untracked files in the Working Changes inspector, and scrolling,
selecting a row, and every watcher re-sync became sluggish.

`ChangedFileList` (`src/features/changes/file-list/ChangedFileList.tsx`) mounts
one DOM row per file and per Tree-view directory. Nothing is virtualized, so the
panel mounts every row on each render. Tree view adds quadratic work on top:
every directory header computes its Stage/Unstage roll-up guard by filtering the
section's whole file list (`dirBlocked` in `WorkingFileSection.tsx`, `guardFor`
in `IncludeFileSection.tsx`). With thousands of directories and files, that is
millions of comparisons per render.

There is no Jira issue for this.

## What Changes

- `ChangedFileList` renders only the rows near the viewport, in both Path and
  Tree view, using `@tanstack/react-virtual`. It is the same library and fixed-row
  pattern as `HistoryWorkspace` and `BranchNavigator`. The list keeps scrolling
  inside the inspector's existing shared scroll container, so the header, the
  Unstaged section and the Staged section still scroll as one page.
- ↑/↓ keyboard navigation scrolls the selected row in through the virtualizer
  (`scrollToIndex`), not `querySelector(...).scrollIntoView()`, because an
  off-screen row is no longer in the DOM.
- The folder roll-up guard is computed once per render from a path lookup
  (path → `FileChange`), not by filtering the whole list for each directory, in
  both the Staging-area and Include sections.
- One change, frontend only. Every inspector that uses `ChangedFileList`
  benefits: Working Changes (Include and Staging area), the selected commit, and
  the merged selection.

## Non-goals

- No change to how the Rust status walk reports untracked files
  (`recurse_untracked_dirs(true)` in `src-tauri/src/git/status/working.rs`), and
  no collapsing of untracked directories into one `dir/` row. That changes what
  the panel shows and what Stage stages, so it is its own decision.
- No change to the per-file line counts the backend computes for untracked files.
- No cap or "show more" on the list. Every file stays reachable by scrolling.
- No change to the centre "review all" workspace, which already virtualizes its
  sections (`StackedReviewList`).
- No visual redesign of rows, headers or actions.

## Capabilities

### New Capabilities

- `changes/file-list`: how the changed-files lists in the right-hand inspectors
  behave at scale: every file stays reachable, and the panel stays responsive
  with thousands of files.

### Modified Capabilities

None.

## Impact

- Process: frontend only. No Rust, IPC, or store change. No secrets, auth or
  credentials are involved.
- Files: `src/features/changes/file-list/ChangedFileList.tsx` (virtualization,
  keyboard scroll), `src/features/changes/WorkingFileSection.tsx` and
  `src/features/changes/IncludeFileSection.tsx` (roll-up guard lookup), and their
  tests. The inspectors (`WorkingInspector.tsx`, `CommitInspector.tsx`,
  `merged-selection/MergedSelectionInspector.tsx`) may need to pass their scroll
  container down.
- Pattern to copy: `src/features/graph/HistoryWorkspace.tsx` and
  `src/components/navigation/branch-navigator/BranchNavigator.tsx` (fixed-height
  rows with `useVirtualizer`).
- Spec: new `openspec/specs/changes/file-list/spec.md`.
- No new dependencies.
