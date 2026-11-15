# Tasks

## 1. Baseline measurement

- [x] 1.1 Build to a scratch `--outDir` with `bunx vite build`, then sum the raw and gzip sizes of every chunk `index.html` loads or modulepreloads. Verify by adding a "baseline (apply)" row to the Measurements table in `design.md`.

## 2. Render-path fixes (findings 2, 3, 4, 5)

- [x] 2.1 In `src/features/graph/commit-row/CommitRow.tsx`, remove the `draggingFrom` subscription and read `useUi.getState().draggingFrom` inside `onDragOver` and `onDrop` (design D4). Verify that `CommitRow.test.tsx` passes, plus a new test showing that a row neither re-renders when any drag starts nor fails to open the action menu on a local-branch drop.
- [x] 2.2 In `src/features/graph/HistoryWorkspace.tsx`, derive `filtering`, `matchedIds`, `queryMatches`, and the rows' `query` prop from `useDeferredValue(histQuery)` (design D5). Verify that the existing history-search tests pass, the search field echoes each keystroke, and the match-count label never shows a count from an older query.
- [x] 2.3 With 2.2 in place, profile typing in the history search on a repo with several thousand loaded commits. Verify by recording the profile result in `design.md` D6, together with the decision to implement or skip D6.
- [x] 2.4 Only if 2.3 decided to implement: add the NUL-joined haystack `WeakMap` to `src/features/graph/historyFilter.ts`, strip NUL from the query, and rewrite the lines 33-35 comment (design D6). Verify with unit tests: each field still matches, a query spanning two fields does not match, and ref-name matches still work. If 2.3 decided to skip, tick this with "skipped per 2.3". Skipped per 2.3.
- [x] 2.5 In `src/features/conflicts/useConflictResolver.ts`, replace the selection `useEffect` and its JSON round-trip with adjust-state-during-render, with `prevKey` starting at `null` (design D7). Verify with tests: the first unresolved file is selected on mount, an auto-selected file stays selected after it resolves, an invalid selection falls back to the first unresolved file, and a manual pick survives a refresh.

## 3. Lazy library leaves (finding 1)

- [x] 3.1 Move the renderer into `src/components/ui/MarkdownRenderer.tsx` with the sanitizer unchanged. Keep `Markdown.tsx` as the wrapper: an eager empty branch, otherwise `lazy` + `Suspense fallback={null}` (design D1). Verify by retargeting `Markdown.test.tsx` to `MarkdownRenderer`, so the sanitizer assertions run against real output, and by adding one wrapper test for the lazy render and the "No description." branch. Both must pass.
- [x] 3.2 Update the tests that assert rendered markdown to await the lazy content (`findBy*`): `PrCommentsMarkdown.test.tsx`, `PrConversation.test.tsx`, `CreatePrDialog.test.tsx`, `RepoFileWorkspace.test.tsx`, `ReviewWorkspace.test.tsx`, plus any others `bun run test` shows failing. Verify that `bun run test` passes.
- [x] 3.3 Split `src/features/terminal/TerminalPanel.tsx` into an eager shell that latches `hasOpened` and a lazy `TerminalBody` that owns `useTerminalPanes`. Move `loadAgents()` to the eager side and update the header comment (design D2). Verify that `TerminalPanel.test.tsx` passes after it awaits the body, and add a test showing agents load while the terminal has never been opened.

## 4. Measure and document

- [x] 4.1 Rebuild to the scratch `--outDir` and add an "after (apply)" row to the Measurements table. Verify that `index.html` no longer references `vendor-terminal` or `vendor-markdown`.
- [x] 4.2 Apply the gate from design D3: if total eager JS dropped by less than 10% and less than 100 kB raw, revert group 3. Verify by stating the decision under the Measurements table.
- [x] 4.3 Add the measurement, whether it passed or failed, to `docs/rules/architecture-rules-react.md` next to the 2026-10-17 note. Verify that the paragraph states that library-leaf splits and workspace splits were measured separately.

## 5. Definition of done

- [x] 5.1 Run `bun check`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes`, `bun run cycles`, and `bun run coverage` (through the `verify` agent). If coverage fails only because the files were split, run `bun run coverage:update` and review the baseline diff. Verify that all exit 0.
- [x] 5.2 In a production build of the app (`bun run tauri build` or the built bundle), open a PR with a markdown body, open the terminal and check its colours, check the enabled-agent badge in Settings before ever opening the terminal, type in the history search on a large repo, drag a branch onto a commit, and resolve a conflict. Verify that each behaves as before with no console errors. If the first markdown or terminal display is visibly blank, add the idle preload from design D1 and repeat. Done 2026-11-15 in a `tauri build --debug --no-bundle` binary (production frontend bundle, debug Rust): all six behaved as before, no first-show blank was visible, so no idle preload was added. The app's `frontend-errors.log` stayed untouched; the devtools console itself was not opened.
