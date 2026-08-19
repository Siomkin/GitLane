## 1. Store: names + groups (view prefs)

- [x] 1.1 Add `src/store/ui/repoLabels.ts`: `RepoGroup { id; name; color }`, `RepoLabel { name?; groupId? }`, state `repoGroups: RepoGroup[]` + `repoLabelsByIdentity: Record<string, RepoLabel>`, and actions `setRepoName(identity, name | null)`, `createRepoGroup(name, color) -> id`, `assignRepoGroup(identity, groupId | null)`, `renameRepoGroup(id, name)`, `deleteRepoGroup(id)`.
- [x] 1.2 Persist through the ui store's existing `persist` allowlist (`persistedRepoLabels`), with a `merge` hook running `sanitizeRepoGroups`/`sanitizeRepoLabels` so a corrupt restored value degrades to `[]` / `{}`.
- [x] 1.3 Wire the slice into `src/store/ui.ts` (`createRepoLabelsSlice` + type export) alongside the existing slices.
- [x] 1.4 Export the fixed group colour set (6 named entries with dark-mode variants) from the slice or `lib/palette.ts`, as named consts — no bare colour string literals at call sites.
- [x] 1.5 Tests (`repoLabels.test.ts`, node project): assign/reassign/remove group, clearing a name reverts to no name, deleting a group leaves its members ungrouped (dangling `groupId` reads as ungrouped), corrupt stored JSON degrades to empty.

## 2. Pure model: labels + group runs

- [x] 2.1 In `src/lib/tabs.ts`, extend `tabDisplay`/`tabLabel` to take an optional custom name for the tab's identity, so a worktree tab renders `<custom name> · <branch>` and a plain tab renders the custom name; absent name keeps `repoLabel(path)`.
- [x] 2.2 Add `groupRuns(openPaths, groupIdOf)` (the caller composes identity) returning an ordered list of `{ groupId: string | null; paths: string[] }` runs: each group emitted at its first member's position, later members pulled into that run, ungrouped tabs kept in place.
- [x] 2.3 Add `runKey`, `moveRun`, and `moveWithinRun` (the flat order a run drag / an in-group drag produces). Tests in `tabs.test.ts`: the `frontend(Acme) / notes / backend(Acme)` ordering from the spec, all-ungrouped input returns one run per tab in order, group order follows first appearance, reorder input → recomputed runs.

## 3. Tab strip UI (folder module)

- [x] 3.1 Create `src/components/chrome/repo-tabs/` and move `ProjectTab.tsx` into it; `TitleBar.tsx` renders a new `RepoTabStrip` container and keeps only chrome layout.
- [x] 3.2 `RepoTabStrip.tsx` + `RepoTabRun.tsx`: render `groupRuns` output — each group as a bordered cluster with its `GroupChip` as the drag handle. Runs are the strip-level sortable (a group moves with its tabs); a group's tabs are a second sortable scoped to that group, so a tab can only be reordered within it.
- [x] 3.3 `GroupChip.tsx`: group name + colour, dark-mode variants, focus ring; purely presentational.
- [x] 3.4 Pass the custom name into `tabDisplay` in `RepoTabStrip` (read from the ui slice by `tabIdentity(path, tabInfoByPath[path])`).
- [x] 3.5 Tests (dom project): three same-named repos in three groups render three distinct chips; a grouped pair split by an ungrouped tab renders contiguously; an ungrouped tab beside a group is outside its cluster.

## 4. Tab context menu

- [x] 4.1 Add `MenuKind.RepoTab` + `RepoTabMenu { x; y; path }` to `src/store/ui/menus.ts`, with a `repoTabMenuOf`-style selector matching the existing per-kind selectors.
- [x] 4.2 Wire `onContextMenu` on the tab (in `ProjectTab`/`RepoTabStrip`) to `openMenu`, so opening it closes any other menu.
- [x] 4.3 Add `src/components/chrome/overlays/menus/RepoTabContextMenu.tsx`: `Rename…` (+ `Use folder name` once named), `Assign to group ▸` (existing groups, excluding the current one; `New group…`), `Remove from group` / `Rename group…` / `Delete group` (hidden when ungrouped), `Close tab`; register it in `overlays/menus/index.ts` / `Overlays`.
- [x] 4.4 Use the existing `requestPrompt` dialog for `Rename…` (default value = current effective label) and `New group…`, following `menus/prompts.ts`; submitting an empty rename clears the custom name.
- [x] 4.5 Tests (dom project): menu hides `Remove from group` when ungrouped and omits the current group from the assign list; rename submit updates the tab label without a repo reload.

## 5. Recents list sections

- [x] 5.1 Add `RecentGroupSection.tsx` next to `HomeScreen.tsx` plus the pure `recentSections()` split in `onboarding.ts`, and render recents grouped by the same path → group lookup, ungrouped section last, most-recent-first within each section.
- [x] 5.2 `RecentRepoRow` shows the custom name when set (path line unchanged); no headings render when no groups exist.
- [x] 5.3 Tests (dom project): grouped + ungrouped sections in order; zero groups renders the flat list as today.
- [x] 5.4 Verify a repository keeps its name/group after `clearRecents` and after eviction past `RECENTS_LIMIT` (covered by the store test in 1.5 plus a render check).

## 6. Docs

- [x] 6.1 Document renaming and grouping repositories in `docs-site/` (a section in `getting-started/first-run.mdx`, where repository tabs are introduced), including that names and groups are local to the machine and never touch the repository.

## 7. Definition of done

- [x] 7.1 `bunx tsc --noEmit`
- [x] 7.2 `bun run lint`
- [x] 7.3 `bun run test`
- [x] 7.4 `bun run build`
- [x] 7.5 `bun run sizes` (confirm `TitleBar.tsx` dropped out of the band and no new file lands over the ceiling)
- [x] 7.6 Exercise in `bun run tauri dev`: rename a repo, create/assign/remove a group, drag tabs across a group run, restart the app and confirm names/groups persist. (No IPC change, so no Rust checks are required.)

## 8. Review follow-ups

- [x] 8.1 Add `RecentRepo.mainPath`, written at open time and backfilled by the recents status probe, and resolve the recents list's name + section through `recentIdentity()` so a worktree row matches its tab.
- [x] 8.2 `createRepoGroup` refuses a blank name (the prompt already did; the store now agrees with `renameRepoGroup`).
- [x] 8.3 `deleteRepoGroup` sweeps the group out of `collapsedRepoGroups` — keyed by group id, nothing else would ever clean it up.
- [x] 8.4 `visualTabOrder` / `neighbourTabPath` take the label state as a parameter (defaulting to the store) so the ordering is unit-testable without the ui store.
- [x] 8.5 Document repository groups and collapsing in `docs-site/.../first-run.mdx`.
