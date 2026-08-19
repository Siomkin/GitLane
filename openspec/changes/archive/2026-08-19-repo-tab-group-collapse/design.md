## Context

See proposal.md — Why. This change stacks on `repo-tab-rename-and-groups`, which introduced:

- `src/store/ui/repoLabels.ts` — `repoGroups` (id / name / colour) plus `repoLabelsByIdentity` (repository identity → custom name + group id), both persisted with the ui store's view preferences.
- `src/lib/tabs.ts` — the pure model: `groupRuns(paths, groupIdOf)` partitions the stored `openPaths` into the runs the strip draws (a group's run sits at its first member and pulls the later ones forward), and `drawnTabOrder` flattens that back to the order the user sees.
- `src/store/repoTab/tabOrder.ts` — `visualTabOrder` / `neighbourTabPath`, the store-side wiring the shortcuts and close-neighbour already go through, so both already follow the drawn order rather than `openPaths`.
- `src/components/chrome/repo-tabs/` — `RepoTabStrip` (container, drag handling), `RepoTabRun` (the well, or a lone ungrouped tab), `GroupChip` (the desaturated name, click-to-rename, and the divider), `ProjectTab`.

The design source is `Tab Groups.dc.html` in the Claude Design project, section "COLLAPSED GROUP": a 28px pill, `rounded-[8px]`, `bg-black/[0.05]`, holding a 12px right-chevron, the name at 12px/600 in `#525252`, and a pill-shaped count badge (`bg-black/[0.08]`, 10px/600, `#737373`). The design draws the collapsed group beside one ungrouped tab and shows no expanded-state chevron.

## Goals / Non-Goals

**Goals:**

- One pure place decides what a run draws, so the strip, the shortcuts, and the close-neighbour pick cannot disagree about the drawn order.
- Collapsing is presentation only: no stored order, membership, or active-repo change.
- The strip stays honest about where the user is — the active tab is never folded away.

**Non-Goals:**

- Collapsing an *ungrouped* tab, or a "collapse all" command.
- Animating the fold. A transition can be added later without touching the model.
- Auto-collapsing on width pressure. Overflow behaviour for a strip too wide to fit is a separate problem this change does not take on.
- Reflecting collapsed state anywhere but the tab strip — the recent-repositories sections and the group menus are unaffected.

## Decisions

**Double-click both ways.** Collapse by double-clicking the name, expand by double-clicking the pill. Single-click-to-expand was tried and rejected: two different gestures for one toggle read as two different controls, and a single click on either surface fights the press that drags the group. Keyboard activation still toggles the pill — an `onClick` with `detail === 0` has no mouse behind it, which keeps Enter/Space working without giving the mouse a single-click path. Menu-only collapsing was the first attempt and was lopsided in the other direction: expanding had a direct gesture and collapsing did not.

**A separate group menu, not more rows on the tab menu.** The two menus have different subjects — the tab menu acts on one repository, the group menu on the group — and a collapsed group has no tab left to right-click, so folding its actions into the tab menu leaves it unreachable. Collapse/expand, rename, and delete move to `RepoGroupContextMenu`; "Remove from group" stays on the tab menu because its subject is that one repository. The design's tab menu keeps all of it in one place, which is where this deliberately departs from it.

**No chevron in the expanded well.** The design draws a chevron on the collapsed pill and nothing at all in the expanded well, so that is what gets built: the well stays pixel-identical to 1C, and the collapse gestures ride on the name and the pill rather than on a new control. A chevron mirrored into the expanded well was tried first and rejected — it is not in the design, and it made the well's head a row of small buttons instead of a name.

**The collapsed pill is one control, not three.** Chevron, name, and count are a single button; nothing inside is separately clickable. A first attempt gave the name and the chevron their own hover states inside the pill, which stopped it reading as one unit.

**The group name carries no rename; renaming stays in the context menu.** An in-place editor on the name was tried and removed: the name already carries the drag press and the collapse double-click, and an editor that swallows a press interferes with both. One rename path, in the menu beside the other group actions.

**No `handleRef` on a group run, and a Distance-only sensor instead.** Two coupled facts about `@dnd-kit/dom`'s pointer-sensor defaults:

1. A press landing inside a declared drag *handle* skips activation constraints entirely, so the drag begins on pointerdown and the `click` never arrives. A handle covering the whole well therefore silently broke the collapse gesture and the group menu. The well stays the plain sortable element.
2. With no handle, the mouse defaults are `Delay(200ms, tolerance 10)` **or** `Distance(5px)` — and the delay half activates a drag from a *stationary* press once 200ms elapses. Any slow click, and either half of a double-click, popped the drag feedback and dropped it again: the jitter reported against the first working build.

3. Independently of the constraints, the sensor's `preventActivation` refuses any press that lands on a nested *interactive* element — and `getInteractiveElement` matches by **tag** (`button`, `a[href]`, inputs, contenteditable), not by role. A collapsed group whose pill was a real `<button>` therefore could not be dragged at all.

So the run declares `PointerSensor.configure({ activationConstraints: [Distance(5)] })`, and the collapsed pill is a `div role="button" tabIndex={0}` with an explicit Enter/Space handler rather than a `<button>`. Movement, and only movement, starts a group drag; clicks, double-clicks and right-clicks inside the well all survive. Tabs are unaffected — their dot-grid handle keeps taking path 1, which is why they never jittered. This is why `@dnd-kit/dom` is now a declared dependency (it was already installed transitively under `@dnd-kit/react`): the constraint classes are not re-exported from the React package.

**Collapsed ids live in the ui store as a `Set`-shaped record, keyed by group id.** `repoLabelsByIdentity` is keyed by *repository identity*, which is the wrong key — collapse is a property of the group, not of a repository. A `collapsedRepoGroups: string[]` (or `Record<string, true>`) beside `repoGroups`, persisted through the same `persistedRepoLabels` list, keeps it next to the groups it describes. A deleted group's leftover id resolves to nothing, the same way a dangling `groupId` already resolves to "ungrouped" — no sweep on delete, one place that reads it.

**`groupRuns` decides what a run draws; nothing downstream re-derives it.** The run type gains `collapsed: boolean` and the paths it draws are narrowed there — a collapsed run keeps its full `paths` (so a drag still moves every member and the count is truthful) and exposes the subset actually drawn. `drawnTabOrder` flattens the drawn subset, which is what makes the shortcut and close-neighbour requirements fall out for free: `visualTabOrder` and `neighbourTabPath` already call it, so neither call site changes. The alternative — letting the strip filter at render and having the shortcuts filter again — is exactly the divergence that produced the ⌘2 regression in the sibling change.

**The active path is an input to the pure model, not a lookup inside it.** `groupRuns` takes the active path as an argument so "a collapsed group still draws the active tab" stays a pure, directly testable rule, and the store/React layer keeps ownership of *what* is active.

**A collapsed group is one sortable, as it already is.** The run is already the strip-level sortable; collapsed, its pill is that sortable's handle and it has no inner tab list. Nothing accepts a drop into it, so the invariant that a drag never changes membership holds by construction — no new drop-target logic.

**The active tab drawn beside a collapsed pill is a plain tab, not a special one.** It keeps the same `ProjectTab` rendering, so the active tab looks the same wherever it sits. It is drawn inside the run (after the pill) rather than promoted out of it, so the group's position in the order is unambiguous.

## Risks / Trade-offs

- **The count and what's drawn can disagree at a glance** — a group of 3 collapsed onto its active tab shows "3" beside one visible tab. Mitigation: the count reads as "this group holds 3", which is the useful number when deciding whether to expand; the alternative ("2 hidden") is a number that changes as the user moves around, which is worse.
- **A collapsed group can hide a repository whose tab the user is looking for** — that is the feature, but it also means ⌘1…9 positions shift when a group is collapsed or expanded. Mitigation: this is the same contract as the drawn order the shortcuts already follow, and it is what the user sees; spec'd explicitly rather than left implicit.
- **The chevron adds ~18px to every expanded group's well**, in a strip that competes with the traffic lights for width. Mitigation: it replaces nothing, but the feature it enables reclaims far more width than it costs.
- **Stacked on an unarchived change** — `openspec/specs/chrome/repo-tabs/spec.md` does not exist yet, so this delta is `ADDED`-only and must be synced after `repo-tab-rename-and-groups`. Mitigation: the requirements here are additive and name no requirement in that change, so ordering is the only coupling.

## Migration Plan

None. New persisted state only: a missing `collapsedRepoGroups` in an existing `gitlane.ui` blob rehydrates to "nothing collapsed", which is the previous behaviour. No rollback story beyond reverting the change.
