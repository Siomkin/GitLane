# Tasks

## 1. Rust write: range stage / unstage / revert

- [x] 1.1 Add `ApplyLineRangeRequest` (file, staged, hunkIndex, lineStart, lineEnd, expected line kinds/contents/old+new numbers) to `src-tauri/src/git/types/requests.rs`, camelCase on the wire; verify `cargo check` passes
- [x] 1.2 Add `src-tauri/src/git/write/patch_staging/range.rs` with `apply_line_range` deriving one patch for the whole range from the `extract.rs` helpers and applying it through `runners.rs` (`--cached`, `-R` when unstaging); verify every expected line is checked before the apply and a mismatch returns the "changed, refresh" error with no index change
- [x] 1.3 Add `revert_line_range` in `range.rs`: requires `staged: false`, refuses when the range overlaps staged content, reverse-applies to the working tree (no `--cached`); verify by unit test that the index is untouched
- [x] 1.4 Add Rust tests beside `src-tauri/src/git/write/tests/staging/lines.rs` covering the `changes/patch-staging` delta scenarios: three-line block below an unstaged insertion, removed+added range, one stale line refuses all, revert lower of two blocks, CRLF revert keeps CR LF, overlap with staged content refuses, file edited after diff refuses; verify `cargo test` passes

## 2. Rust read: differences with inclusion

- [x] 2.1 Add `FileDifferences`, `Difference`, `DifferenceTarget`, and the `included | excluded | partial` inclusion enum under `src-tauri/src/git/types/` and re-export flat; verify `cargo check` passes
- [x] 2.2 Add `src-tauri/src/git/status/differences.rs`: HEAD → working tree (D) and index → working tree (U) at `context_lines(0)`, classify each D block per design Decision 2, compute unstaged and staged targets per Decision 3, and return the 3-context HEAD → working-tree `FileDiff` with each difference addressed by its rendered rows; verify the file stays under the Rust size ceiling
- [x] 2.3 Add tests under `src-tauri/src/git/status/tests/` for: two unstaged edits → two excluded; staged line 10 + unstaged line 80 → included + excluded; partly staged block → partial; staged change reverted in the worktree → no difference (an alignment disagreement cannot be built deterministically; the exact-body check guards it); renamed/binary/untracked → no per-difference targets; verify `cargo test` passes

## 3. IPC wiring

- [x] 3.1 Add `working_file_differences`, `apply_line_range`, `revert_line_range` as `async fn` + `blocking(...)` in `src-tauri/src/commands/staging.rs` and their path-qualified entries in `lib.rs` `generate_handler!`; verify the `commands/registration_tests/` suite passes
- [x] 3.2 Add the TS interfaces in `src/lib/api/git/types` and the zod request schema in `src/lib/api/schemas`, and the three wrappers in `src/lib/api/git/staging.ts` (parsing the request like `applyLine`); verify `bunx tsc --noEmit` passes
- [x] 3.3 Add a `staging.ts` wrapper test with the inline `vi.hoisted` + `vi.mock` invoke pattern asserting command names and snake_case args; verify `bun run test` passes

## 4. Store and view preference

- [x] 4.1 Add `applyLineRange` and `revertLineRange` actions to the repo store (`src/store/repoWriteActions/staging.ts`) calling `lib/api` then refreshing and reselecting like `applyLine`; the store has no in-flight gate for patch writes, so the Include pane disables its controls while a write is pending (6.2) and the backend's stale guard refuses a doubled click; verify a store test of the request shape, the refresh, and the toast on refusal
- [x] 4.2 Add a persisted `changesView: "include" | "staging"` (default `include`) and `setChangesView` beside `fileListView` in `src/store/ui/appearance.ts`; verify a slice test that it defaults to `include`, is in the persisted keys, and survives a repo switch

## 5. Working Changes panel: Include / Staging switch

- [x] 5.1 Add pure helpers for the combined Include list (union of staged and unstaged paths in path order, each with its tri-state from the two buckets, and the source a selection should use) in `src/features/changes/includeList.ts` with tests (folder roll-up state included); verify `bun run test` passes
- [x] 5.2 Add the `Include | Staging area` switch to `WorkingInspector` bound to `changesView`; verify a render test that switching changes the list shown and nothing else (no IPC call)
- [x] 5.3 Add the combined three-state list as its own component (`IncludeFileSection.tsx`) rendered by `WorkingInspector` in Include view: three-state row checkbox (check → `stageFile`, uncheck → `unstageFile`, partly → stage), Tree-view folder roll-ups with the same rule, filter, context menu, and selection opening the single-file review; extend `FileRow` / `ChangedFileList` row action with a partly-checked state rather than forking them; verify render tests for each state and that `WorkingInspector` stays under the size ceiling

## 6. Include diff in the single-file review

- [x] 6.1 Add an optional gutter render prop to `src/features/review/SplitDiff.tsx` and `UnifiedDiff.tsx` without changing existing callers; verify existing review tests pass unchanged
- [x] 6.2 Add `includeDiffModel.ts` (pure: file order, difference navigation wrapping into the next/previous file, "N differences, M included", disabled reasons reusing `hunkPatchUnavailableReason`) with tests covering wrap-around and the "5/17 files" position; verify `bun run test` passes
- [x] 6.3 Add `useFileDifferences.ts` loading `working_file_differences` for the selected path and refetching on each new working-changes snapshot; verify a hook test that a refresh reloads it
- [x] 6.4 Add `IncludeDiffPane` (`features/review/include-diff/`) with the toolbar and per-difference checkbox + `>>` revert, controls disabled while a write is pending and disabled with a reason on included/partial differences and whole-file-only files; route `ReviewWorkspace` to it for working-tree files in Include view; verify render tests that checking calls `applyLineRange` with the difference's `stage` ranges, unchecking with its `unstage` ranges, revert calls `revertLineRange` only for excluded differences, and Staging-area view still renders the bucket diff
- [x] 6.5 Add the pencil to the Include toolbar opening the existing file editor (`openRepoFile` + `beginFileEdit`, saving through `write_repo_file` with its unsaved-changes guards; closing returns to the diff), disabling it for binary and deleted files; the editor keeps a CRLF file's endings on save and opens mixed-ending files read-only with the reason (`src/lib/lineEndings.ts`, `repoFilesActions`); verify tests that a CRLF file round-trips with CR LF intact and a mixed-ending file stays read-only with the reason
- [x] 6.6 Register previous/next difference (⌥↑/⌥↓) and previous/next file (⌥←/⌥→) chords in `src/lib/shortcuts.ts`, active only while the Include pane is shown and not colliding with existing bindings (resolves design Open Question); verify a shortcuts test and that the chords appear in the shortcuts list

## 7. Docs

- [x] 7.1 Update the `CLAUDE.md` "Frontend layout" text for the Changes tab (Include / Staging-area views in `WorkingInspector`, `IncludeDiffPane` in the single-file review); verify the paths it names exist

## 8. Integration checks

- [x] 8.1 Run `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes`, `bun run cycles`, and in `src-tauri` `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test`; verify all exit 0
- [x] 8.2 In `bun run tauri dev` on a scratch repo: include the second of three differences from the Include view and confirm `git diff --cached` shows only it; uncheck it; revert an excluded difference and confirm the index is unchanged; `git add` a file in a terminal and see its checkbox update; edit and save via the pencil toggle; commit one included difference and confirm the other stays unstaged

## 9. Whole file, side labels, and word highlights

- [x] 9.1 Add a `whole_file` option to `working_file_differences` (`git/status/differences.rs`, `commands/status.rs`, `FileDifferences.wholeFile`, `statusApi.workingFileDifferences`) that renders the HEAD → working-tree diff with unlimited context and falls back to 3-context with `wholeFile: false` past `DIFF_LINE_LIMIT`; verify Rust tests that whole-file mode returns one hunk with every line, the same inclusions as hunk mode, targets that stage exactly the chosen difference, and the fallback for an over-limit file
- [x] 9.2 Add the Whole file toggle to the Include toolbar (sticky per session in `ReviewWorkspace`), refetch with `wholeFile`, hide hunk headers via a `hideHunkHeaders` prop on `SplitDiff` / `UnifiedDiff`, and show the too-large note on fallback; verify a render test that the toggle refetches with `wholeFile: true`, no hunk header renders, and checkboxes still call `applyLineRange`
- [x] 9.3 Add optional `sideLabels` to `SplitDiff` and pass `HEAD · <short sha>` / `Working tree` from the Include diff; verify a render test of both labels in split mode and none in unified
- [x] 9.4 Add `src/lib/wordDiff.ts` (token LCS with a token cap and a no-common-word skip) and `features/review/wordMarks.ts` (pair removed/added lines per change run), paint the ranges in `Tokens` / `SplitHalf` / `UnifiedLine`; verify unit tests for the three `review/diff` scenarios and a render test that a changed word gets the highlight in both views

## Workflow follow-up

- Run `/opsx:verify` against the specs, then archive with `/opsx:archive`, merging into `openspec/specs/changes/commit/` (new) and `openspec/specs/changes/patch-staging/`.
