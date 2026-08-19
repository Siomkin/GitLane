## Context

See `proposal.md` — Why. Current state that shapes the approach:

- The tab strip is `components/chrome/TitleBar.tsx` mapping `openPaths` through `ProjectTab`, inside a `DragDropProvider` whose `onDragEnd` calls `reorderOpenPaths`. Tab presentation is already a pure model: `lib/tabs.ts` (`TabInfo`, `tabDisplay`, `tabLabel`, `tabIdentity`, `groupedInsertIndex`), with `tabIdentity(path, info)` returning the main checkout's path for a worktree — the identity key this change needs already exists.
- Repo labels come from `repoLabel(path)` (leaf directory) in two places: `tabDisplay` and the recents entry's `name` field.
- The recents list is `features/onboarding/screens/HomeScreen.tsx` mapping `ob.recents` through `RecentRepoRow`. `RecentRepo` is persisted by `store/repoSession.ts`, capped at 12 (`RECENTS_LIMIT`) and wiped by `clearRecents` — so it is not a safe home for durable user data.
- Context menus go through the single exclusive slot in `store/ui/menus.ts` (`MenuKind`, `openMenu`, per-kind selectors) and render from `components/chrome/overlays/menus/`. Prompts for free text use the existing `requestPrompt` dialog (`PromptRequest`), as `menus/prompts.ts` does.
- View preferences live in `store/ui/*` slices and persist to `localStorage` under `gitlane.<name>:v1` (see `pinnedNavRefsByRepo`); git data lives in `store/repo.ts` and is not persisted.
- This is frontend-only. No Rust, no IPC, no new dependency (`docs/tauri-plugin-decisions.md` therefore does not apply).

## Goals / Non-Goals

**Goals:**

- One source of truth for a repository's display name and group, consumed by both the tab strip and the recents list.
- Grouping is a *pure, testable function* over the existing tab order — not a second ordering the user has to maintain.
- Nothing about today's behavior changes when no name or group has been set.

**Non-Goals (design level, beyond the proposal's):**

- No new Zustand store. No Rust or IPC layer. No change to `RecentRepo`'s shape or to `repoSession.ts` persistence.
- No group state on the backend and nothing written into the repository.

## Decisions

**Engine: none — frontend-only.** No libgit2 read, no git CLI write, no `forge::context()` provider. There is no new/changed Tauri command, so the four IPC layers are untouched.

**Store: a new `store/ui/repoIdentityLabels.ts` slice, not `repo.ts`.** Names and groups are view preferences with the same lifetime and persistence rules as `pinnedNavRefsByRepo` and panel widths; `repo.ts` holds git-derived, non-persisted state. *Alternative rejected:* extending `RecentRepo` in `repoSession.ts` — recents are capped at 12 and `clearRecents` wipes them, so the names would silently vanish, violating the "persist independently of recents" requirement.

**Keyed by repository identity, not path.** The map is keyed by `tabIdentity(path, info)` (main checkout path for a worktree, own path otherwise), which is exactly what makes a worktree tab inherit the parent's name and group for free. *Alternative rejected:* keying by open path — a repo and its three worktrees would need renaming four times.

**Persisted through the ui store's existing `persist` allowlist, not new `localStorage` keys.** `useUi` already persists a partialized allowlist under `gitlane.ui`; `repoGroups` (an ordered `RepoGroup[]` — order is meaningful in the recents list, and an array keeps it without a separate order field) and `repoLabelsByIdentity` (`Record<identityPath, { name?; groupId? }>`, both fields optional) join it via `persistedRepoLabels`. *Alternative rejected:* two hand-rolled `gitlane.*:v1` keys as `repoSession.ts` does — same durability, more code, and a second persistence mechanism inside the same store.

Because these are the one persisted shape a user may end up hand-editing, the store's `persist` gains a `merge` hook running `sanitizeRepoGroups` / `sanitizeRepoLabels`: an unreadable value degrades to `[]` / `{}` (the spec's corrupt-preferences scenario) and a partially corrupt map keeps its readable half. A dangling `groupId` (group deleted) resolves to ungrouped in `repoGroupOf` rather than being swept from every label.

**Grouping is a pure function in `lib/tabs.ts`, computed at render.** `groupRuns(openPaths, identityOf, groupIdOf)` partitions the *existing* tab order into runs: each group's run is emitted at the position of its first member, pulling that group's later members forward; ungrouped tabs stay where they are. Drag order remains the single stored order, and group contiguity is derived from it — so a drag can never leave a group visually split and `reorderOpenPaths` needs no change. *Alternative rejected:* physically moving tabs in `openPaths` on assignment (like `groupedInsertIndex` does for worktrees) — it mutates the user's order behind their back and still can't stop a later drag from splitting the run.

**A run is the drag unit; tabs reorder only inside their own group.** The strip is a sortable list of *runs* (a group with its tabs, or a lone ungrouped tab), and a group's tabs are a second sortable list scoped to that group (`type`/`accept` of `repo-tab:<groupId>`), so a tab has no valid drop target outside its run. Group membership therefore changes only through the context menu. *Alternative rejected — and the first implementation, which was wrong:* one flat sortable over all tabs. Dropping a tab between two grouped tabs put it at that index without joining the group, so it drew flush against the group and read as a member; re-parenting the dragged element between runs mid-drag also left an orphaned drag clone on screen. Confining drags to a run removes both failure modes by construction rather than by patching the drop handler. The group's cluster gets its own ring so "next to" and "inside" are visibly different.

**Colours: a small fixed named set** (6 values) exported alongside the slice, chosen from the existing Tailwind/token palette with dark-mode variants — not free colour entry and not the graph lane palette (lane colours carry a different meaning; reusing them would imply a relationship that doesn't exist).

**Menu: a new `MenuKind.RepoTab` in `store/ui/menus.ts`** carrying `{ x, y, path }`, rendered by `components/chrome/overlays/menus/RepoTabContextMenu.tsx`. It reuses the existing exclusive-slot behaviour (so opening it closes any other menu, satisfying the menu-exclusivity scenario) and the existing `requestPrompt` dialog for "Rename…" and "New group…" — copying `menus/prompts.ts` rather than inventing a new dialog.

**Size ceiling / folder module.** `TitleBar.tsx` is already sizeable and gains a group-chip layer; the strip moves into a folder module `components/chrome/repo-tabs/` (`RepoTabStrip.tsx` container, `ProjectTab.tsx` moved in, `GroupChip.tsx`, with the pure model staying in `lib/tabs.ts`), leaving `TitleBar.tsx` as chrome layout only. `HomeScreen.tsx` gains a `RecentGroupSection.tsx` sibling rather than inline section rendering. Verify with `bun run sizes`.

## Risks / Trade-offs

- **Grouping recomputed on every strip render** → the input is `openPaths` (tens of entries at most) and the function is a single pass; no memo needed. Measurable cost is nil compared to the graph canvas.
- **A group run pulls a later tab forward, so a tab can appear to "move" when a group is assigned** → this is the intended Chrome-like behavior and is stated in the spec; the stored order is unchanged, so removing the tab from the group restores the visual position exactly.
- **`localStorage` is per-machine and not synced** → declared a non-goal; the same limitation already applies to every other view preference.
- **A renamed repo becomes harder to find by folder name** → the path stays in the tab tooltip and on the recents row's path line, unchanged.
- **Two same-named groups** → allowed; groups are identified by id, and forbidding duplicate names would add validation for no user benefit.

## Migration Plan

No migration. Both keys are new; an absent key means "no names, no groups", which renders exactly today's UI. Rollback is removing the feature — the two keys are then simply unread and can be left in place.

**Recents carry the repository identity, not just their own path.** A recents entry records the path that was opened, which for a linked worktree is the worktree — not the repository its name and group are keyed by. Rather than re-probing the filesystem from the start screen, `RecentRepo` gained `mainPath`, written at open time from `summary.mainPath` and backfilled by the status probe that already refreshes each entry's branch and missing flag. `recentIdentity()` then applies the same rule as `lib/tabs.ts`'s `tabIdentity`. Without it a worktree row showed its folder name and sectioned as Ungrouped while its tab showed the repository's name and group — the same data disagreeing with itself in two places.
