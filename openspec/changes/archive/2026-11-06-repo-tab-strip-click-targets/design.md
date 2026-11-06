# Design

## Context

See proposal.md (Why). The tab strip lives in `src/components/chrome/repo-tabs/`:

- `ProjectTab.tsx` is one tab: a root `div` that is the drag surface, a 20px grip `<button>` overlaid on a 14px icon slot, a label `<button>` and a close `<button>`. Selection was wired to the label button only. The working tree already moves `onClick={onSelect}` to the root and drops it from the label (the label's click, including Enter/Space, bubbles to the root).
- `GroupChip.tsx` holds `useGroupGestures`, which both group presentations spread: the expanded name (`span`, `cursor-pointer`) and the collapsed pill (`div role="button"`, `cursor-pointer`). Today it uses `onDoubleClick`, keyboard Enter/Space, and right-click.
- A pointer cursor on `button` / `[role=button]` comes from the `@layer base` rule in `src/App.css`. The tab root has none.
- Drags use `@dnd-kit/react` 0.5. Group runs activate after 5px (`RUN_SENSORS` in `RepoTabRun.tsx`). Tabs drag by their grip handle.

Engine: frontend only. No libgit2, git CLI, forge or IPC. Store: none new; `toggleRepoGroupCollapsed` in the `ui` store is reused unchanged.

## Goals / Non-Goals

**Goals:**
- Every pixel of the strip that shows a hand acts on a single click.
- A drag never toggles or selects on release.

**Non-Goals:**
- No new drag-detection mechanism of our own unless verification shows dnd-kit's suppression leaks.

## Decisions

**1. Rely on dnd-kit's post-drag click suppression.** When a drag ends, dnd-kit's `PointerSensor.handlePointerUp` (`node_modules/@dnd-kit/dom/index.js`) installs a one-tick capture listener that swallows the trailing click. Pointer capture sits on `body`, so that click targets `body`. During the drag, the source also has a `click` listener with `preventDefault`. Together they mean a released drag should never reach our `onClick`.
*Alternative:* track a "just dragged" flag from `onDragEnd` in `RepoTabStrip` and check it in each handler. Rejected for now, because it duplicates the library and adds state threaded through `RepoTabRun`. Task 3.1 verifies this in the running app. If a click leaks, the fallback is to ignore clicks while `ui.draggingFrom` or the sortable's `isDragging` is set.

**2. Ignore the 2nd+ click of a multi-click with `event.detail > 1`.** Clicking the name collapses the group, and the pill renders under the pointer. A double-click's second click then lands on the pill with `detail === 2`, and ignoring it keeps one toggle per double-click. Keyboard-synthesised clicks have `detail === 0`, but the pill handles Enter/Space in `onKeyDown` anyway (with `preventDefault`, so no synthetic click double-fires).
*Alternative:* a time-based debounce. Rejected: `detail` is the platform's own multi-click counter and needs no timer.

**3. The tab root gets `cursor-pointer`.** It sits in Tailwind's `utilities` layer, so the grip's own `cursor-grab` still wins over the grip, and buttons keep their base-layer pointer.

**4. `onDoubleClick` is removed, not kept beside `onClick`.** Keeping both would toggle twice on a double-click.

Size: `GroupChip.tsx` (109 lines) and `ProjectTab.tsx` (~185) are far below the ceiling, so no split is needed.

## Risks / Trade-offs

- [WebKit (macOS Tauri webview) may not increment `detail` when the second click lands on a different element (the pill replacing the name).] → Task 3.1 checks a real double-click in `bun run tauri dev`. If it toggles twice, fall back to ignoring a click within the system double-click interval after the last toggle.
- [Users used to double-click now see one toggle per double-click; that is the intended outcome.] → The first-run guide is updated.
- [A slow press that moves under 5px is a click, so it toggles.] → Intended. That's what the pointer cursor promises.
