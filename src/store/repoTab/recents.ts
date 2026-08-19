// The recents list: re-probing each entry on disk, and removing/clearing them.

import { api } from "@/lib/api";
import { persistRecents } from "@/store/repoSession";
import { type RepoGet, type RepoSet, type RepoState } from "@/store/repoTypes";

export function createRecentsActions(
  set: RepoSet,
  get: RepoGet,
): Pick<RepoState, "refreshRecents" | "removeRecent" | "clearRecents"> {
  return {
    // Probe each recent's path on disk: flag the ones that no longer resolve as
    // `missing` and refresh their current branch. Best-effort — a probe failure
    // leaves the list untouched. Merged by path so a concurrent open isn't lost.
    refreshRecents: async () => {
      const paths = get().recents.map((r) => r.path);
      if (paths.length === 0) return;
      try {
        const statuses = await api.recentsStatus(paths);
        const byPath = new Map(statuses.map((s) => [s.path, s]));
        const next = get().recents.map((r) => {
          const status = byPath.get(r.path);
          // When present, trust the probed branch (null = detached, clearing a
          // stale label); when missing, keep the last-known branch to display.
          if (!status) return r;
          return {
            ...r,
            missing: !status.exists,
            branch: status.exists ? status.branch : r.branch,
            // Backfills entries recorded before `mainPath` existed, so an old
            // worktree row starts resolving to its repository identity without
            // waiting to be reopened. A vanished path keeps its last-known
            // value rather than being flattened to null.
            mainPath: status.exists ? (status.mainPath ?? null) : r.mainPath,
          };
        });
        persistRecents(next);
        set({ recents: next });
      } catch {
        /* best-effort: keep the existing recents on a status probe failure */
      }
    },

    removeRecent: (path) => {
      const next = get().recents.filter((r) => r.path !== path);
      persistRecents(next);
      set({ recents: next });
    },

    clearRecents: () => {
      persistRecents([]);
      set({ recents: [] });
    },
  };
}
