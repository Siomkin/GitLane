# Proposal

## Why

In the title-bar tab strip, some spots show a hand cursor but do nothing on a single click. On a repository tab, only the name text selects the tab: the padding, the gaps around the name and the area around the drag grip are dead. A group's name and a collapsed group's pill show the hand but respond only to double-click. A user who clicks once sees nothing happen and can't tell why.

No Jira issue exists for this.

## What Changes

- A single click anywhere on a repository tab's surface selects that tab. Only the close button (×) behaves differently: it closes the tab. The whole tab shows the pointer cursor, so every part that looks clickable is.
- A single click on an expanded group's name collapses the group, and a single click on a collapsed group's pill expands it. This replaces double-click as the mouse gesture. **BREAKING** (behaviour): double-click no longer works as a separate gesture. Its first click toggles the group and its second click is ignored, so a habitual double-click still toggles once rather than collapsing and re-expanding.
- A press that becomes a drag (5px of movement) never toggles a group or selects a tab when it is released.
- Keyboard activation (Enter / Space on the focused pill or tab label) is unchanged.
- The first-run guide's "Collapse a group" passage is updated to say "click" instead of "double-click".

Frontend only: no Rust, no IPC, no stores or persisted settings change.

## Non-goals

- Redesigning the tab or the group chip (layout, grip placement, sizes, colours).
- Auditing pointer cursors elsewhere in the app (action bar, panels, menus). That is separate work if wanted.
- Changing drag-to-reorder, the context menus or the activation distance.
- Adding a separate collapse button to the expanded well. The requirement that the well carries no other collapse control stays.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `chrome/repo-tabs`: "Collapsing a group" changes from double-click to single click, guarded against drag release and against the second click of a double-click. A new requirement says the whole repository tab surface selects the tab.

## Impact

- `src/components/chrome/repo-tabs/ProjectTab.tsx`: the select handler moves from the label button to the tab root, and the root gets the pointer cursor. Partly done already in the working tree.
- `src/components/chrome/repo-tabs/GroupChip.tsx`: `useGroupGestures` switches from `onDoubleClick` to a guarded `onClick`.
- `src/components/chrome/repo-tabs/RepoTabStrip.test.tsx`: the double-click tests become single-click tests, and the "ignores a single mouse click" test is reversed.
- `docs-site/src/content/docs/getting-started/first-run.mdx`: the collapse passage.
- Security, auth and IPC: none. No secrets or commands are involved.
- Pattern to copy: drag/click separation already relies on dnd-kit's `PointerSensor` (`RUN_SENSORS` in `RepoTabRun.tsx`), which suppresses the click after a drag. No new mechanism is added.
