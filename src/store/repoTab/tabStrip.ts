// Tab-strip upkeep: drag-reordering the open tabs and keeping a background
// tab's label (branch, worktree identity) truthful without loading the repo.

import { arrayMove } from "@dnd-kit/helpers";
import { api } from "@/lib/api";
import { tabInfoFromStatus } from "@/lib/tabs";
import { ensureTabLifetime, tabLifetimeIsCurrent } from "@/store/repoRequests";
import { persistSession, persistTabInfo, readLastPath } from "@/store/repoSession";
import { type RepoGet, type RepoSet, type RepoState } from "@/store/repoTypes";

export function createTabStripActions(
  set: RepoSet,
  get: RepoGet,
): Pick<RepoState, "reorderOpenPaths" | "setTabOrder" | "refreshTabInfo"> {
  return {
    reorderOpenPaths: (fromIndex, toIndex) => {
      const { openPaths, summary } = get();
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= openPaths.length ||
        toIndex >= openPaths.length
      ) {
        return;
      }

      const next = arrayMove(openPaths, fromIndex, toIndex);
      persistSession(next, summary?.path ?? readLastPath());
      set({ openPaths: next });
    },

    // The grouped tab strip renders a derived order (a group's members drawn
    // together), so a drag there yields a whole order rather than one move.
    // Rejecting anything that isn't a permutation keeps a stale render from
    // dropping or duplicating a tab.
    setTabOrder: (paths) => {
      const { openPaths, summary } = get();
      if (paths.length !== openPaths.length) return;
      const open = new Set(openPaths);
      if (!paths.every((path) => open.has(path)) || new Set(paths).size !== paths.length) return;

      persistSession(paths, summary?.path ?? readLastPath());
      set({ openPaths: paths });
    },

    // A background tab's watcher fired: re-probe the path so its tab label
    // (branch, worktree identity) stays live without loading the repo — the
    // full data reload still happens on activation (loadRepo). Best-effort;
    // a probe failure keeps the last-known label.
    refreshTabInfo: async (path) => {
      if (!get().openPaths.includes(path)) return;
      const owner = ensureTabLifetime(path);
      try {
        const [status] = await api.recentsStatus([path]);
        if (!status?.exists) return;
        // Re-check both membership and the exact lifetime after the await: a
        // same-path close/reopen is a different tab even though `includes`
        // alone would look unchanged.
        if (!tabLifetimeIsCurrent(owner) || !get().openPaths.includes(path)) return;
        const tabInfoByPath = {
          ...get().tabInfoByPath,
          [path]: tabInfoFromStatus(status),
        };
        persistTabInfo(tabInfoByPath);
        set({ tabInfoByPath });
      } catch {
        /* best-effort: keep the existing tab info */
      }
    },
  };
}
