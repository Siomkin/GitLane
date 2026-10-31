# Tasks

## 1. Drag styling under the CSP (D1)

- [x] 1.1 Add `src/components/chrome/repo-tabs/dndFeedback.css` with the rules from design D1.
  Copy them from `@dnd-kit/dom` 0.5.1's injected `CSS_RULES`, written without CSS nesting.
  Add the drag-only `user-select: none` and `cursor: grabbing` rules scoped by
  `:root:has([data-dnd-dragging])`. Verify: every selector in D1's list is present.
- [x] 1.2 Import `dndFeedback.css` from `App.css` right after `@import "tailwindcss"`
  (design D1 says why not from `RepoTabStrip.tsx`). Verify: `bun run build` succeeds, the
  built CSS contains `data-dnd-dragging`, and its layers still run `properties, theme, base`.
- [x] 1.3 In the browser pane (Vite dev, tabs added through the store), disable dnd-kit's
  injected `<style>` (`sheet.disabled = true`) and drag a tab and a group. Verify: the dragged
  item is under the pointer, the placeholder has `visibility: hidden`, and the dragged item
  has `pointer-events: none`. Without the bundled sheet, the same check showed the item at 0,0.

## 2. Stable reordering (D2)

- [x] 2.1 Add `@dnd-kit/collision` to `package.json` dependencies at the version
  `@dnd-kit/dom` resolves (`^0.5.1`) with `bun add`. Verify: `bun.lock` lists it as a
  direct dependency.
- [x] 2.2 Pass a `collisionDetector` to the run-level `useSortable` and to `GroupedTab`'s
  `useSortable` in `RepoTabRun.tsx` (design D2). Verify: `bun check` passes.
- [x] 2.3 Rerun the scripted drags in the browser pane, with the injected sheet disabled as in
  1.3, 2px pointer steps, and the order logged every step. Drag a 116px tab left across a
  2-tab group tray, a narrow tab across a wide tab, then reverse. Drag a narrow grouped tab
  past a wide one in its group, drag a group right, and jiggle ±6px after a swap. Verify: one
  order change per item passed (was 49 / 23), the final order is persisted, a reversal swaps
  back once, and the jiggle swaps nothing. The stock `directionBiased` and `closestCenter`
  both failed this, so the strip uses its own order-aware `stripCollision` (design D2).
- [x] 2.4 Unit-test `stripCollision` (`stripCollision.test.ts`, node project) with fake
  sortables: a passed item ahead in the direction of travel is a target, one behind is not,
  one not yet passed is not, another group's item is not, the dragged item's own slot always
  is, and no direction means no new target. Verify: `bun run test` passes.

## 3. Tests (D3)

- [x] 3.1 Add `src/components/chrome/repo-tabs/dndFeedback.test.ts` (node project). It
  extracts the `data-dnd-*` attribute names and `--dnd-*` custom properties from the
  installed `@dnd-kit/dom/index.js` and asserts each appears in `dndFeedback.css`. Verify:
  the test passes, and fails when one variable is renamed in a scratch copy of the CSS.
- [x] 3.2 Try a happy-dom render test in `RepoTabStrip.test.tsx`: start a pointer drag on a
  tab handle and assert `position: fixed` on the dragged element and `visibility: hidden` on
  the placeholder. Keep it only if it runs reliably under happy-dom; otherwise leave a
  one-line comment in `dndFeedback.test.ts` naming the manual check in 4.x that covers it.
  Verify: `bun run test` passes either way.
- [x] 3.3 Confirm the existing CSP assertion in `src/components/ui/markdownCsp.test.ts`
  (`style-src 'self'` without `'unsafe-inline'`) is untouched and passing.
  Verify: `bun run test`.

## 4. In-app verification

- [x] 4.1 `bun run tauri dev` on macOS. Drag an ungrouped tab, a grouped tab, an expanded
  group by its name, and a collapsed pill. Verify each spec scenario in
  `specs/chrome/repo-tabs/spec.md`: no corner copy, no duplicate in the strip, no text
  selection, no flicker, order persisted after a restart. Passed (user, 2026-10-31).
- [ ] 4.2 Same check on Ubuntu (WebKitGTK). Also note whether the drag-time `user-select`
  rule applies there (`:has` support); record the WebKitGTK version if it doesn't.
- [ ] 4.3 On both platforms, with tabs that fit the strip, drag across the strip. Verify no
  horizontal scrollbar appears. If one still does, leave `AutoScroller` out of the strip's
  `DragDropProvider` plugins (design, Risks) and repeat 4.1–4.3. macOS passed (user,
  2026-10-31); Ubuntu pending.

## 5. Docs

- [x] 5.1 Add the dnd-kit paragraph to the Content Security Policy section of
  `docs/tauri-plugin-decisions.md`, beside the xterm entry (design D4). Verify: it names
  `dndFeedback.css`, the expected console message, the parity test, and "do not re-open
  `style-src`".

## 6. Definition of done

- [x] 6.1 `bun check`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes`,
  `bun run cycles`: all exit 0.
