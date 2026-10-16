# Design

## Context

See proposal.md (Why). The pieces mostly exist and are composed here:

- The Changes tab is already a commit tool window: the center shows the single-file review
  (`features/review/ReviewWorkspace`, driven by the store's `selectedFile`) or, via "review all",
  the stacked `changes-workspace/ChangesWorkspace`; the right panel shows
  `features/changes/WorkingInspector` — Unstaged/Staged `ChangedFileList` sections with stage
  checkboxes, filter, Path/Tree toggle, and the always-mounted `CommitComposer` (Commit, Amend,
  identity, Commit and Push, Commit-Push-Open-PR).
- `features/review/SplitDiff` + `hunkActions.ts` — side-by-side diff with per-hunk and per-line
  stage/unstage through `apply_hunk` / `apply_line` (`git/write/patch_staging/`). Both target the
  index only, one hunk or one line per call.
- `repo-files/file-workspace/FileEditor` (textarea over a highlighted backdrop, change bars,
  overview ruler) + `write_repo_file` (size + state-token guard).
- `git/status/compare.rs` already builds a base-tree-to-working-tree diff; all status diffs use
  `context_lines(3)`.

Constraints: reads are libgit2, writes are the git CLI; layout/derivation stays in Rust; no new
dependency, plugin, or capability.

## Goals / Non-Goals

**Goals:**
- Two views over the git index in the existing Changes tab (Include default, Staging-area toggle),
  reusing the right-hand Working Changes panel as the commit panel.
- Per-difference inclusion computed in Rust; the frontend only renders states and sends back
  opaque, content-checked ranges.
- Every write is one atomic git operation with the existing stale-selection refusal.
- The new pieces read only the repo path and store state, so a later change can host the panel
  and the diff in a second window.

**Non-Goals:**
- Inline editing inside the aligned two-column diff (v1 opens the file editor, see Decision 5).
- Changing the stacked "review all" view (`ChangesWorkspace`) or the History-mode inspectors.
- Reverting staged content; changelist-style private selection; a second webview.

## Decisions

### 1. Engines

- **Read** (libgit2): new per-file "differences" read in `git/status/` beside `compare.rs`.
- **Write** (git CLI): range stage/unstage and range revert in `git/write/patch_staging/`, built on
  the existing patch derivation in `extract.rs` and `git apply` runners in `runners.rs`. Stage /
  unstage use `git apply --cached` (and `-R` to unstage) as today; revert uses `git apply -R`
  against the working tree (no `--cached`). No libgit2 writes.

### 2. What a "difference" is, and how inclusion is derived

For the selected file the read takes three diffs and splits each hunk into blocks, the maximal runs of
changed lines between context lines (identical to `context_lines(0)` blocks, since the edit script
does not depend on context):

- **D** = HEAD → working tree (one entry per contiguous change block: the user-visible differences)
- **U** = index → working tree (unstaged blocks)
- **S** = HEAD → index (staged blocks)

Each block has a span on each side (zero-width where it occupies no line, e.g. a pure deletion on
the new side). Classification of a D block:

- **excluded** — no S block overlaps it in HEAD line numbers, and exactly one U block overlaps it
  with the same removed and added lines (the index equals HEAD in that region);
- **included** — no U block overlaps it in working-tree line numbers (the working tree equals the
  index there, so the change is staged);
- **partial** — anything else, including any case the two diffs align differently.

`partial` is the conservative fallback: it shows as partly checked and disables revert, so a Myers
alignment disagreement between D and U can never enable a destructive action.

Alternative considered: compute inclusion in the frontend from the existing staged + unstaged
diffs. Rejected — it is layout-style derivation across two diffs (Rust owns that), and the
three-way mapping is exactly where a bug becomes data loss.

### 3. The write payload is an addressed range into the existing diffs

The 0-context blocks always sit inside one hunk of the existing 3-context staged or unstaged diff
(a 3-context hunk is a union of 0-context blocks plus context). So for each difference the read
also returns its **targets**: `{ staged: bool, hunkIndex, lineStart, lineEnd }` plus each line's
expected kind / content / old+new line numbers — the same addressing and stale check
`ApplyLineRequest` already uses, widened from one line to a contiguous range.

A block's unstaged targets are the U blocks overlapping it in working-tree line numbers (the new
side of both D and U). Its staged targets are the S (HEAD → index) blocks overlapping it in HEAD
line numbers (the old side of both D and S). Each pair shares a side, so no offset translation
between images is needed. The 3-context staged and unstaged diffs are the same `file_diff` reads
the staging buttons already address, so the targets use identical hunk and line indices.

The read also returns the renderable 3-context HEAD → working-tree `FileDiff` (the same shape
`SplitDiff` renders today), with each difference addressed by the rows it covers, so the gutter
controls map straight onto rendered rows without a second read.

- Check a difference → apply its unstaged targets with `staged: false`.
- Uncheck → apply its staged targets with `staged: true` (reverse to unstage).
- Revert (`excluded` only, after a confirm dialog — a reverted block has no undo) → reverse-apply its single unstaged target to the working tree. The
  backend re-derives the patch and refuses if any expected line no longer matches, or if the range
  overlaps staged content.

Alternative considered: calling `apply_line` once per line. Rejected — not atomic; a refresh or
external edit mid-sequence leaves a half-applied difference.

### 4. IPC — four layers per command (all land together)

| Command | Impl | Command + handler | Types | TS wrapper |
|---|---|---|---|---|
| `working_file_differences(path, file)` read | `git/status/differences.rs` (new), over the shared `git/diff_blocks.rs` | `commands/status.rs` + `generate_handler!` in `lib.rs` | `FileDifferences`, `Difference`, `Inclusion` in `git/types/differences.rs` (camelCase) | `src/lib/api/git/status.ts` |
| `apply_line_range(path, request)` write | `git/write/patch_staging/range.rs` (new) | `commands/staging.rs` + `generate_handler!` | `ApplyLineRangeRequest`, `DiffLineRange` in `git/types/differences.rs` | `src/lib/api/git/staging.ts` |
| `revert_line_range(path, request)` write | `git/write/patch_staging/range.rs` | `commands/staging.rs` + `generate_handler!` | reuses `ApplyLineRangeRequest` (`staged` must be false) | `src/lib/api/git/staging.ts` |

All three are `async fn` + `blocking(...)`. No secrets cross IPC. `extract.rs` is at 357 lines
(Rust look band), so range code goes in the new `range.rs`, reusing `extract.rs` helpers.

### 5. Editing: the pencil opens the existing file editor

The current column of an aligned diff has spacer rows and per-row tokens, and the in-app editor's
draft / save / unsaved-changes state is owned by the store's `fileView` flow. So the Include
toolbar's pencil opens that flow instead of embedding a second editor: `openRepoFile(path)` then
`beginFileEdit()`, which shows `RepoFileWorkspace` in edit mode (⌘S saves through
`write_repo_file` with its state token; Done / Close keep the unsaved-changes confirm). Closing it
clears `fileView`, and the Changes tab's single-file review — and so the Include diff — shows
again, refetched on the next working-changes snapshot. The editor's textarea always yields LF, so
the store holds the draft as LF and writes it back in the file's own style (`src/lib/lineEndings.ts`):
a CRLF file keeps CR LF on every line. A file with mixed endings has no single style to write back,
so it opens read-only with the reason on the Edit button; binary and deleted files disable the
pencil.

Alternative considered: swapping the diff's current column for an inline editor. Rejected for v1
— it duplicates the load / save / unsaved-changes handling `fileView` already owns. It can replace
the pencil later without changing the spec.

### 6. Frontend layout: the existing Changes tab, two views

No new surface. The Changes tab's layout already works as a commit tool window (diff in the
center, file list + composer beside it), so the change lives in its two halves:

- **Right panel — `WorkingInspector`.** An `Include | Staging area` switch under the header.
  - Include: one combined list (`ChangedFileList` over the union of staged and unstaged paths)
    whose row checkbox is three-state — checked when the path is only in `staged`, partly checked
    when in both, unchecked when only in `unstaged`. Checking stages the whole file
    (`stageFile`), unchecking unstages it (`unstageFile`); a partly checked file checks.
    Selecting a row opens it in the single-file review.
  - Staging area: today's Unstaged / Staged sections, unchanged.
  - Filter, Path/Tree toggle, Discard all, context menus, conflicts, and the composer are shared
    by both views. Folder roll-ups in Tree view follow the same three-state rule.
- **Center — `ReviewWorkspace`.** For a working-tree file in Include view it renders a new
  `IncludeDiffPane` instead of the bucket diff; Staging-area view and committed files are
  unchanged.
  - `IncludeDiffPane` (new, `features/review/include-diff/`): toolbar (↑ ↓ difference,
    `← n/N files →`, edit toggle, "N differences, M included", split/unified) over `SplitDiff` /
    `UnifiedDiff` of the HEAD → working-tree diff, with per-difference controls (tri-state
    checkbox, `>>` on excluded) drawn through an optional gutter render prop. Whole-file-only
    files show the diff without controls and the reason (`hunkPatchUnavailableReason` rules).
  - `useFileDifferences.ts` loads `working_file_differences` for the selected path, refetching on
    every new working-changes snapshot (the GL-173 cache rule `useWorkingTreeDiffs` follows).
  - `includeDiffModel.ts` (pure): file navigation order (the combined list's order), difference
    navigation with wrap into the next/previous file, counts, file tri-state, disabled reasons.
- The stacked "review all" view (`ChangesWorkspace`) is untouched.

`SplitDiff` and `UnifiedDiff` gain an optional gutter render prop rather than more built-in
branches (`SplitDiff` is 227 lines).

### 7. State

- Repo store (`src/store/repoWriteActions/staging.ts`): `applyLineRange`, `revertLineRange` →
  `lib/api` → refresh + reselect, like `applyLine`. The store has no in-flight gate for patch
  writes; `IncludeDiffPane` disables its controls while one is pending, and the backend's stale
  guard refuses a doubled click. No new store.
- Selection: Include view keeps using `selectedFile` (`path` + `source`); the source only decides
  which bucket diff the Staging-area view shows, so the combined list selects with the source the
  file currently has (`unstaged` when it has any unstaged change, else `staged`).
- UI store: a persisted `changesView: "include" | "staging"` (default `include`) beside the
  persisted `fileListView` in the `appearance` slice — the same kind of list-presentation
  preference; no new slice (`ui.ts` is on the cohesion watch-list).
- `src/lib/shortcuts.ts`: previous/next difference and previous/next file chords, active only while
  the Include pane is shown.

### 8. Whole file, side labels, and word highlights

- **Whole file** (`changes/commit`). `working_file_differences(path, file, wholeFile)` builds only
  the displayed HEAD → working-tree diff with unlimited context (one hunk); differences are still
  blocks of that diff, and their `stage` / `unstage` targets still address the normal 3-context
  staged and unstaged diffs, so the writes are untouched. If the whole-file diff would pass
  `DIFF_LINE_LIMIT`, the read returns the 3-context diff with `wholeFile: false` and the toolbar
  says the file is too large. The toolbar toggle is sticky per session beside split / unified
  (`ReviewWorkspace` state); `SplitDiff` / `UnifiedDiff` take `hideHunkHeaders`. Folding long
  unchanged runs is not in v1.
- **Side labels** (`changes/commit`). `SplitDiff` takes optional `sideLabels`, drawn as a fixed
  row above the scroller; the Include diff passes `HEAD · <short sha>` and `Working tree`.
- **Word highlights** (`review/diff`). A pure token-level LCS in `src/lib/wordDiff.ts` (words,
  whitespace runs, and single punctuation as tokens; skipped above a token cap and when the pair
  shares no word) gives changed ranges per side. `features/review/wordMarks.ts` pairs the k-th
  removed with the k-th added line of each change run — the pairing `flattenSplit` already uses —
  and `Tokens` paints the ranges over its syntax colours. Presentation only, so it stays in the
  frontend; it reaches every `SplitDiff` / `UnifiedDiff` (Include, staged / unstaged, committed
  file). The stacked review and PR diffs use other renderers and are unchanged.

## Risks / Trade-offs

- [D and U align differently for the same edit] → classified `partial`: checkbox still works (stage
  or unstage all of it), revert disabled.
- [Rapid checkbox clicks race the refresh] → each write carries expected content and refuses when
  stale; controls are disabled while a write is in flight.
- [Large diff, per-file read cost] → the differences read runs only for the selected file; truncated
  diffs keep whole-file controls only.
- [File editor instead of inline edit] → editing leaves the diff for the full-file view and returns
  on close; keeps alignment logic and a second save path out of the diff.
- [Users used to the two-section list] → the Staging-area view keeps today's behaviour one toggle
  away and is remembered.
- [`WorkingInspector` is 382 lines] → the combined Include list goes in its own component file so
  the inspector stays under the 400-line ceiling; run `bun run sizes`.

## Migration Plan

No data migration. The Changes tab keeps its layout and entry points; today's two-section list and
bucket diff become the Staging-area view. Rollback is reverting the change; the new commands are additive.

## Open Questions

- Resolved: ⌥↑ / ⌥↓ step differences and ⌥← / ⌥→ step files (contextual, skipped while a text
  field or the terminal has focus); they collide with no existing binding.
