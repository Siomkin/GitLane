// The branch-navigator dropdown and its per-repo pins.

import { useRepo } from "@/store/repo";
import type { SliceSet } from "./slice";
import { persistedKeys } from "./slice";

export interface NavigatorSlice {
  /** Branch navigator dropdown raised by the "Checked out" trigger. Transient. */
  navOpen: boolean;
  /** Refs pinned to the top of the branch navigator's lists: repo path →
   * `pinKey(kind, name)` (e.g. `"local|develop"`) → true. Keyed by repo like
   * `graphWidthsByRepo` — a bare ref name is not unique across repositories, so
   * a flat map would pin `main` everywhere at once. Persisted. */
  pinnedNavRefsByRepo: Record<string, Record<string, true>>;

  openNav: () => void;
  closeNav: () => void;
  toggleNav: () => void;
  /** Pin/unpin a navigator ref (key = `pinKey(kind, name)`) in the open repo.
   * No-ops when no repo is open — a pin has nowhere to belong. */
  toggleNavPin: (key: string) => void;
}

/** The branch navigator. Its pins are per-repo and persist; only the dropdown
 * itself closes. */
export const resetNavigator = () => ({ navOpen: false }) satisfies Pick<NavigatorSlice, "navOpen">;

export const persistedNavigator = (s: NavigatorSlice) => persistedKeys(s, ["pinnedNavRefsByRepo"]);

/** The branch-navigator dropdown owns the keyboard while it is up. */
export const overlayOpenNavigator = (s: NavigatorSlice) => s.navOpen;

export function createNavigatorSlice(set: SliceSet<NavigatorSlice>): NavigatorSlice {
  return {
    ...resetNavigator(),
    pinnedNavRefsByRepo: {},

    openNav: () => set({ navOpen: true }),
    closeNav: () => set((s) => (s.navOpen ? { navOpen: false } : s)),
    toggleNav: () => set((s) => ({ navOpen: !s.navOpen })),
    toggleNavPin: (key) =>
      set((s) => {
        const repoPath = useRepo.getState().summary?.path;
        if (!repoPath) return s;
        const pinned = { ...(s.pinnedNavRefsByRepo[repoPath] ?? {}) };
        if (pinned[key]) delete pinned[key];
        else pinned[key] = true;
        return { pinnedNavRefsByRepo: { ...s.pinnedNavRefsByRepo, [repoPath]: pinned } };
      }),
  };
}
