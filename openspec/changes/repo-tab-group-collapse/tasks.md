## 1. Store: collapsed state

- [x] 1.1 Add `collapsedRepoGroups: string[]` to `RepoLabelsSlice` in `src/store/ui/repoLabels.ts`, defaulting to `[]`, and add it to `persistedRepoLabels`.
- [x] 1.2 Add `toggleRepoGroupCollapsed(groupId: string)` and a `repoGroupCollapsed(state, groupId): boolean` reader beside `repoGroupOf`, so a dangling id (deleted group) resolves to "not collapsed" in one place.
- [x] 1.3 Add `sanitizeCollapsedRepoGroups` alongside the existing sanitizers, and wire it into the ui store's persist `merge` next to `sanitizeRepoGroups` / `sanitizeRepoLabels`, so a hand-edited or corrupt value degrades to "nothing collapsed".
- [x] 1.4 Tests (node): toggle on/off; a collapsed id survives a rehydrate; a legacy `gitlane.ui` blob with no `collapsedRepoGroups` rehydrates to `[]`; junk values (non-array, non-string members) sanitize away.

## 2. Pure model

- [x] 2.1 Extend `TabRun` in `src/lib/tabs.ts` with `collapsed: boolean` and the drawn subset (`paths` stays the full membership — the drag unit and the count read it).
- [x] 2.2 Extend `groupRuns` to take the collapsed predicate and the active path, and to narrow a collapsed run's drawn paths to the active tab alone (or to none when the active tab is elsewhere). Keep it idempotent over the flattened *stored* order.
- [x] 2.3 Point `drawnTabOrder` at the drawn subset, so folded-away tabs leave the order the shortcuts and close-neighbour follow.
- [x] 2.4 Confirm `moveRun` / `moveWithinRun` still operate on full `paths` — a collapsed group must move every member — and that `moveWithinRun` is unreachable for a collapsed run.
- [x] 2.5 Tests (node): a collapsed group contributes nothing to the drawn order; contributes exactly the active tab when it holds it; the count equals full membership either way; `moveRun` over a collapsed run preserves all of its paths; the stored order is unchanged by collapsing.

## 3. Wiring the drawn order

- [x] 3.1 Pass the collapsed predicate and the active path through `visualTabOrder` in `src/store/repoTab/tabOrder.ts`, so `neighbourTabPath` and the shortcuts inherit the new order with no change at their call sites.
- [x] 3.2 Tests (dom): ⌘1, ⌘9, and the step shortcuts skip a collapsed group (the spec's `[Acme collapsed] notes desktop` case); closing the tab beside a collapsed group lands on the next drawn tab, not a folded-away one.

## 4. Strip presentation

- [x] 4.1 `GroupChip.tsx`: add `CollapsedGroupChip` (chevron + name + count as one control) and a shared `useGroupGestures` — double-click toggles, right-click raises the group menu. The expanded well keeps only the static name and divider.
- [x] 4.2 `RepoTabRun.tsx`: render a collapsed run as the design's pill (28px, `rounded-[8px]`, `bg-black/[0.05]`, 12px chevron, 12px/600 name, pill count badge — with dark-mode equivalents), followed by the active tab when the group holds it. The pill is the run sortable's handle.
- [x] 4.3 Keep the expanded well exactly as design 1C specifies apart from the added chevron.
- [x] 4.4 Accessibility: the pill is a button with an explicit expanded/collapsed label naming the group and its count; keyboard activation toggles it even though a single mouse click does not.
- [x] 4.5 Tests (dom): collapsing hides the group's tabs and shows the pill with the right count; expanding restores them in order; a collapsed group holding the active tab still draws that tab; activating elsewhere folds it away; the menu offers the right row for each state and none when ungrouped.

## 4b. Group context menu

- [x] 4b.1 Add a `RepoGroup` menu kind (`store/ui/menus.ts`): payload, `OpenMenu` arm, and a `repoGroupMenuOf` selector.
- [x] 4b.2 Add `RepoGroupContextMenu.tsx` — collapse/expand, `Rename group…`, `Delete group` — and register it in `overlays/menus/index.ts` and `AppOverlays`.
- [x] 4b.3 Move those rows out of `RepoTabContextMenu.tsx`; keep `Remove from group` there, since its subject is the one repository.
- [x] 4b.4 Tests (dom): the group menu's three actions, a deleted group rendering nothing, and the tab menu no longer offering any group-wide row.

## 4c. Drag feel

- [x] 4c.1 Give the group run a Distance-only pointer sensor so a stationary press can no longer activate a drag after 200ms (the source of the drag jitter). Declare `@dnd-kit/dom` in `package.json` — already installed transitively, but the constraint classes are not re-exported from `@dnd-kit/react`.
- [x] 4c.2 Make the collapsed pill a `div role="button"`, not a `<button>`: dnd-kit's `preventActivation` blocks a drag starting on a nested interactive element (matched by tag, not role), which left a collapsed group undraggable.
- [x] 4c.3 Give the collapsed run's drawn tab its real index in `run.paths` rather than a hardcoded `0`, so `moveWithinRun` can never splice the wrong path.
- [x] 4c.4 Confirm by hand that dragging a group — expanded and collapsed — is as smooth as dragging a tab, and that double-click / right-click still work on both.

## 5. Verify

- [x] 5.1 `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run sizes`.
- [x] 5.2 Check the strip by hand in `bun run tauri dev` against the design: collapsed pill, expanded well, both themes, a collapsed group holding the active tab, and dragging a collapsed group.
- [x] 5.3 `openspec validate repo-tab-group-collapse --strict`.
