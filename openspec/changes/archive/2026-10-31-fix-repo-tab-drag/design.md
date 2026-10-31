# Design

## Context

The motivation is in proposal.md (Why); the required behavior is in
`specs/chrome/repo-tabs/spec.md`.

- **Engine:** no git involved. This is frontend-only work in
  `src/components/chrome/repo-tabs/`. No IPC command changes, so no four-layer work.
  No Zustand store changes: `setTabOrder` in `src/store/repo.ts` is called exactly as today.
- **How dnd-kit 0.5.1 draws a drag:** `DragDropManager` always installs a core
  `StyleInjector`; the `plugins` option can't remove it. When a drag starts, the `Feedback`
  plugin moves the dragged element into the browser's top layer (`showPopover`). It then
  writes the element's position into `style=""` attributes as custom properties (`--dnd-top`,
  `--dnd-left`, `--dnd-translate`, `--dnd-width`, …). The stylesheet `StyleInjector` puts in
  `<head>` is what reads them. The `Cursor` and `PreventSelection` plugins add two more
  injected rules: a grabbing cursor and `user-select: none` while a drag runs.
- **Why it breaks in the app:** the CSP (`style-src 'self'; style-src-attr 'unsafe-inline'`)
  allows the attributes but blocks the injected `<style>`. The popover is left with the
  browser's default styles: `position: fixed; inset: 0`, and Tailwind's base styles set
  `margin: 0`. So it sits at 0,0 and ignores the translate. The placeholder dnd-kit leaves in
  the strip is also visible, and `pointer-events` stay on. This was reproduced in the browser
  pane by disabling the injected sheet.
- **Why it flickers:** dnd-kit's default collision rule (pointer inside an item, else shape
  overlap) re-targets the wider item right after a swap, because the pointer is still inside
  it. Measured: 49 flips while a 116px tab crossed a 344px group, after which the tab hadn't
  moved; 23 flips across a 183px tab. A group dragged over narrower tabs was fine (2 flips).
- **File sizes:** `RepoTabRun.tsx` is 178 lines and `RepoTabStrip.tsx` 100, both well under
  the 200-line threshold where the size check starts flagging a file. No split is needed.

## Goals / Non-Goals

**Goals:**
- The drag looks and behaves the same in the browser pane and in the app. The browser pane
  can then serve as the quick check, with the app as the confirmation.
- The bundled copy of dnd-kit's rules can't silently drift from the installed dnd-kit version.

**Non-Goals:**
- Getting rid of the CSP console message dnd-kit's blocked `<style>` still produces. The core
  plugin can't be removed, so the message is accepted and documented.
- Tuning drag animation, the drag cursor beyond restoring "grabbing", or auto-scroll speed.

## Decisions

### D1: Bundle dnd-kit's drag rules as a stylesheet next to the strip

Add `src/components/chrome/repo-tabs/dndFeedback.css`, imported from `App.css` straight
after `@import "tailwindcss"`. It isn't imported from `RepoTabStrip.tsx` the way
`useTerminalPanes.ts` imports `xtermAnsi.css`: imported from a component, it landed ahead of
Tailwind in the bundle and declared the `base` layer before `theme`. It holds the rules
dnd-kit 0.5.1 injects, rewritten without CSS nesting:

- the dragged element (`[data-dnd-dragging]`): `position: fixed`, the `top` / `left` /
  `width` / `height` / `translate` / `transform` / `transition` / `scale` driven by the
  `--dnd-*` properties, `pointer-events: none` on it and its descendants, top `z-index`;
- the popover reset for the dragged element (`margin`, `padding`, `border`, `background`,
  `overflow`), in Tailwind's `base` layer, so utilities still win over it. dnd-kit's own
  `@layer dnd-kit` is prepended for the same lowest-priority effect;
- the placeholder: `[data-dnd-placeholder='hidden'] { visibility: hidden }` and no transition;
- the hidden backdrop and overlay rules;
- the two global rules, scoped so they only apply during a drag:
  `:root:has([data-dnd-dragging]) * { user-select: none; cursor: grabbing }`.

Values are copied as dnd-kit writes them, including `!important`, so the bundled sheet and
the injected one (in the browser) give the same result. In the browser both sheets apply.
In the app only the bundled one does.

*Alternatives:*
- `'unsafe-inline'` in `style-src`: rejected by `docs/tauri-plugin-decisions.md`, and
  browsers ignore it once Tauri adds its nonces anyway.
- `StyleInjector.configure({ nonce })` with Tauri's per-page nonce read from the DOM at
  runtime: couples the strip to how Tauri rewrites assets, and doesn't work under
  `vite dev` in a browser.
- dnd-kit's `DragOverlay` component: it still relies on the same injected rules.

### D2: An order-aware collision rule for the strip's sortables

`src/components/chrome/repo-tabs/stripCollision.ts` exports `stripCollision`, passed as
`collisionDetector` to both `useSortable` calls in `RepoTabRun.tsx`: the run-level sortable
(groups and ungrouped tabs) and `GroupedTab`. An item is a target only when all three hold:
- it is in the same sortable group as the dragged item;
- it is *ahead* of the dragged item in the current order, in the direction the pointer is
  moving (lower index when moving left, higher when moving right);
- the dragged item's centre has passed the item's centre.

The dragged item's own slot always stays a target, so standing still means "stay here".
Among passed items the nearest centre wins.

Why not a stock rule: right after a swap, dnd-kit animates the item that was passed over to
its new place. Mid-animation its box still sits where the dragged item is heading, so every
geometry-only rule picks it again and the pair swaps back. Taking order into account removes
that: an item already passed is *behind* the dragged one, so it can't be picked until the
pointer turns round. And turning round needs the dragged centre to cross back over the
item's centre, which gives the reverse swap some slack. Measured with 2px steps:

| Drag | dnd-kit default | `directionBiased` | `closestCenter` | `stripCollision` |
|---|---|---|---|---|
| tab left across a 2-tab group | 49 flips | 88 | 40 | 1 swap |
| narrow tab across a wide tab | 23 | 28 | 4 | 1 |
| reverse back over it | – | 27 | 1 | 1 |
| narrow past wide inside a group | – | 29 | 1 | 1 |
| ±6px jiggle after a swap | – | – | – | 0 |

The rule builds on `closestCenter`'s result (for the collision's id, type and priority) and
reads each sortable's `index` and `group` structurally. The collision input is typed against
`@dnd-kit/abstract`, which `isSortable`'s `@dnd-kit/dom` overloads don't accept.

It measures from the dragged shape's centre, so it only works once D1 puts the dragged
element where the pointer is. D1 lands first.

Declare `@dnd-kit/collision` in `package.json`, at the version `@dnd-kit/dom` already pulls
in, rather than importing a dependency the app doesn't declare.

*Alternatives:* `directionBiased` and `closestCenter`, both measured in the table above.
Keeping the default and debouncing reorders would hide the flicker but not fix it.

### D3: Guard the copy with a test

`dndFeedback.css` duplicates library internals, so `dndFeedback.test.ts` (node project)
checks it against the installed version. It reads `@dnd-kit/dom`'s published `index.js`,
extracts the attribute and custom-property names it uses (`data-dnd-dragging`,
`data-dnd-placeholder`, `data-dnd-dropping`, `--dnd-top`, …), and asserts each one appears
in `dndFeedback.css` (read with Vite's `?raw` import). A dnd-kit upgrade that renames any of
them fails this test instead of silently bringing the corner bug back.

A rendering check (happy-dom: start a drag and assert the dragged element's computed
`position` and the placeholder's `visibility`) is a second, optional test. happy-dom's
support for `:has`, `@layer` and popovers is partial, so it is added only if it runs
reliably there. The browser-pane and in-app checks in tasks are what prove D1 and D2.

### D4: Record it in the CSP decision log

Add a paragraph to the CSP section of `docs/tauri-plugin-decisions.md`, next to xterm's. It
covers four points:
- dnd-kit injects a blocked `<style>` and the app ships `dndFeedback.css` instead;
- the CSP console message that remains is expected;
- the parity test guards the copy;
- the decision is "do not re-open `style-src` for that", as for xterm.

## Risks / Trade-offs

- **[A dnd-kit upgrade changes how drags are drawn]** → The parity test (D3) fails on renamed
  attributes or variables. Behavior changes that keep the names are caught by the manual
  drag check, which the upgrade has to rerun.
- **[Both sheets apply in the browser]** → They hold identical declarations, so the result is
  the same. The bundled one makes the browser match the app rather than differ from it.
- **[`:has()` support in older WebKitGTK]** → Only the drag-time `user-select` and cursor
  rules use it. If an old WebKitGTK lacks `:has`, text selection during a drag returns but
  positioning still works. The Ubuntu check in tasks confirms which case applies.
- **[The horizontal scrollbar has another cause]** → It didn't reproduce in Chromium in any
  run. If it survives D1 in the app, the next suspect is dnd-kit's `AutoScroller` scrolling
  the strip's `overflow-x-auto` row. It can be left out of the strip's plugins
  (`plugins: (defaults) => defaults.filter((p) => p !== AutoScroller)`). The strip is one row
  and doesn't need auto-scroll while its tabs fit. Tasks hold this as a conditional step.

## Migration Plan

None. No stored data or settings change. Rollback is reverting the change.
