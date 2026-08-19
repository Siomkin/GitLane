## Why

Repository tabs and the "Recent repositories" list are labeled by the leaf directory name. Anyone working across several projects that use the same conventional folder names — `frontend`, `backend`, `api`, `web` — sees three identically-named tabs with no way to tell which project each belongs to. The path is only visible in a tooltip, so identifying the right tab means hovering each one.

No Jira issue exists for this yet; one should be created before implementation so the branch/commit/PR can carry the key.

## What Changes

- A repository can be given a **custom display name** that replaces the folder-derived label wherever the repo is listed: the title-bar tab strip and the onboarding "Recent repositories" list.
- A repository can be assigned to a **named, colored group** ("Client A", "Work", "Personal"). Groups are user-created and ordered.
- The tab strip renders groups Chrome-style: members of a group are drawn contiguously in a tinted well, preceded by the group's name and a divider (design 1C). The name is desaturated — a group must never outrank the active tab — and is static: renaming stays in the tab context menu.
- The recents list renders one section header per group, with ungrouped repositories last.
- Both are reachable from a **right-click context menu on a repository tab**: `Rename…`, `Assign to group ▸` (existing groups, `New group…`, `Remove from group`), plus the existing `Close`.
- Custom names and group membership are keyed by **repository identity** (the main checkout's path), so a linked worktree tab inherits its parent repository's custom name and group. Recent-repository entries record that identity too (`RecentRepo.mainPath`), so a worktree row in the recents list resolves the same way its tab does.
- Names and groups persist independently of the recents list, so clearing recents or aging out of the 12-entry cap does not lose them.
- Frontend-only: no new Tauri command, no Rust change, no new dependency.

### Non-goals

- Collapsing/expanding a tab group.
- Dragging a tab into or out of a group to change its membership (membership changes only through the menu).
- Syncing names or groups across machines, or storing them inside the repository (`.git/config`).
- Renaming anything on disk, or renaming branches/worktrees.
- Grouping in the branch navigator or anywhere other than the tab strip and recents list.

## Capabilities

### New Capabilities

- `chrome/repo-tabs`: how open repositories are labeled, ordered, and grouped in the title-bar tab strip and the recents list — custom names, user-defined groups, and the tab context menu that edits them.

### Modified Capabilities

(none — no existing spec covers the tab strip)

## Impact

- **Frontend only.** `src/components/chrome/` (`TitleBar.tsx`, `ProjectTab.tsx`, a new group-chip row and tab context menu), `src/features/onboarding/screens/` (`HomeScreen.tsx`, `RecentRepoRow.tsx`), `src/lib/tabs.ts` (pure grouping/ordering helpers), `src/store/ui/` (a new slice owning names + groups, alongside `menus.ts` for the new menu kind).
- **Persistence:** two new fields on the ui store's existing persisted allowlist (`gitlane.ui`). No migration; an absent value degrades to today's behavior.
- **No IPC change**, no Rust change, no new npm/Cargo dependency, no Tauri capability or CSP change.
- **No secrets, auth, or credential surface** is touched.
- `TitleBar.tsx` is already near the size band; the tab-strip rendering moves into a folder module (`components/chrome/repo-tabs/`).
