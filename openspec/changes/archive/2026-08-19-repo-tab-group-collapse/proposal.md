## Why

Repo groups (`repo-tab-rename-and-groups`) keep a repository's tabs together, but they do not make the strip any shorter — a user with three grouped projects open still pays full width for every tab of every group. Collapsing a group folds the ones they are not working in down to a single pill, which is the whole point of grouping in a tab strip that has to fit beside the traffic lights.

The design (`Tab Groups.dc.html`, "COLLAPSED GROUP") specifies the collapsed presentation; this change implements it.

## What Changes

- A group can be **collapsed**: its well folds to a single pill carrying a chevron, the group's name, and a count of the tabs it holds. Expanding restores the well.
- Collapsing is a double-click of the group's name and expanding a double-click of the collapsed pill — one gesture both ways.
- **Group actions get their own context menu**, raised by right-clicking the group. Collapse/expand, rename, and delete move out of the tab menu, which stays scoped to one repository — and a collapsed group, whose tabs are folded away, gets the menu it otherwise wouldn't have. The expanded well is left exactly as the design draws it, and the group name keeps its click-to-rename behaviour.
- **The active tab is never hidden.** A collapsed group that holds the active tab draws that one tab beside its pill; the rest fold away. Activating a tab of a collapsed group (⌘1…9, ⌘⇧[/], the recents list) therefore never leaves the user unable to see where they are.
- Collapsed state is **per group, persisted** with the rest of the view preferences, so a workspace layout survives a restart.
- Tab shortcuts and the close-neighbour pick continue to follow the *drawn* order — a folded-away tab is not a tab the user can step to, so it is not in that order.
- A collapsed group still drags as one piece, by its pill.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chrome/repo-tabs`: the grouped tab strip gains a collapsed presentation, the rules for what a collapsed group still shows (the active tab), and the effect of collapsing on the drawn tab order that shortcuts and close-neighbour follow.

Note: `openspec/specs/chrome/repo-tabs/spec.md` does not exist yet — the capability is introduced by the in-flight change `repo-tab-rename-and-groups`. This delta stacks on it and should be synced after it.

## Impact

- `src/store/ui/repoLabels.ts` — a persisted set of collapsed group ids, and the toggle action.
- `src/lib/tabs.ts` — the pure model: a run gains "collapsed" and the paths it still draws, and `drawnTabOrder` narrows to what is actually drawn.
- `src/components/chrome/repo-tabs/` — `RepoTabRun.tsx` (the two presentations), `GroupChip.tsx` (the pill, the count, and the shared group gestures).
- `src/store/ui/menus.ts` + `src/components/chrome/overlays/menus/RepoGroupContextMenu.tsx` — a new menu kind for the group, and the group-wide rows moved out of `RepoTabContextMenu.tsx`.
- `src/components/chrome/useShortcuts.ts` and `src/store/repoTab/closeRepo.ts` — no change expected; both already index the drawn order.
- No backend, no IPC, no new dependency.
