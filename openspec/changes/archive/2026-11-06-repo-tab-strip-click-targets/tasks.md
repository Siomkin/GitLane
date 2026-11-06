# Tasks

## 1. Repository tab surface selects

- [x] 1.1 In `src/components/chrome/repo-tabs/ProjectTab.tsx`, keep `onClick={onSelect}` on the tab root (already in the working tree), keep it off the label button, and add `cursor-pointer` to the root's classes. Verify the close button still calls `e.stopPropagation()` so closing never selects.
- [x] 1.2 In `src/components/chrome/repo-tabs/RepoTabStrip.test.tsx`, add tests for clicking the tab root (outside the label) to select it, and for clicking close not selecting. Verify with `bunx vitest run src/components/chrome/repo-tabs`.

## 2. Single-click group toggle

- [x] 2.1 In `src/components/chrome/repo-tabs/GroupChip.tsx`, replace `onDoubleClick: toggle` in `useGroupGestures` with an `onClick` that returns early when `e.detail > 1` and otherwise toggles. Update the hook's doc comment and the `CollapsedGroupChip` / `GroupChip` titles ("click to collapse/expand"). Verify `bun check` passes.
- [x] 2.2 In `RepoTabStrip.test.tsx`, turn the double-click collapse/expand tests into single-click (`fireEvent.click`) tests, and reverse "ignores a single mouse click on the pill" into "a single click expands; a click with `detail: 2` does not toggle". Keep the keyboard assertion. Verify with `bunx vitest run src/components/chrome/repo-tabs`.
- [x] 2.3 In `docs-site/src/content/docs/getting-started/first-run.mdx` ("Collapse a group you're not working in"), change "Double-click" to "Click" for both the name and the pill. Verify by grepping that no group "double-click" wording is left in `docs-site/src/content/docs`.

## 3. Verification

- [x] 3.1 In `bun run tauri dev`, check each of these: (a) clicking tab padding, the gaps and the grip selects the tab; (b) dragging a tab by its grip and dragging a collapsed pill or group name never selects or toggles on release; (c) a fast double-click on a group name collapses it and leaves it collapsed. If (b) or (c) fails, apply the fallback in design.md (Risks) and re-check.
- [x] 3.2 Run `bun check`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes` and `bun run cycles`; all pass.
