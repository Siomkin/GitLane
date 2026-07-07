// Per-repo terminal tabs. Each repo keeps its own list of terminal tabs so
// switching repos shows that repo's shells rather than resetting to one empty
// terminal (the reset bug). Several tabs per repo run several shells at once.
//
// This store holds only the *metadata* (which tabs exist, their titles, which is
// active) keyed by **repo identity** — `summary.path`, the same key `openPaths`
// uses — so `closeRepoTerminals(path)` and reconcile line up with the rest of the
// app (the shell's cwd, `summary.workdir`, is a separate concern resolved by the
// panes manager at spawn time). The live xterm instances + Rust PTYs are owned
// imperatively by `useTerminalPanes`, which reconciles against this state:
// creating a pane for each new tab, disposing panes for closed tabs. It is
// deliberately NOT a `persist` store — PTY processes die with the app, so there
// is nothing meaningful to restore across a restart.

import { create } from "zustand";
import { repoLabel } from "@/lib/paths";

/** One terminal tab. `id` is a frontend uuid — stable for the tab's lifetime and
 *  the key the panes manager maps to a live xterm + PTY session. */
export interface TermTab {
  id: string;
  /** Tab label, e.g. `GitLane 1` (repo basename + a per-repo counter). */
  title: string;
}

interface RepoTerminals {
  tabs: TermTab[];
  activeId: string | null;
  /** Monotonic per-repo counter feeding tab titles, so numbering keeps climbing
   *  even after tabs are closed (no confusing reuse of "GitLane 2"). */
  nextNumber: number;
}

interface TerminalsState {
  byRepo: Record<string, RepoTerminals>;
  /** Append a tab for `repoPath`, make it active, and return its id. */
  openTab: (repoPath: string) => string;
  /** Close a tab. Returns `true` when the repo has no tabs left afterwards
   *  (the caller hides the drawer). Picks a neighbour as the new active tab. */
  closeTab: (repoPath: string, id: string) => boolean;
  setActiveTab: (repoPath: string, id: string) => void;
  /** Ensure `repoPath` has at least one tab (creates the first on demand).
   *  Returns the active tab id. */
  ensureTab: (repoPath: string) => string;
  /** Drop all of a repo's tabs when its repo tab is closed. The panes manager
   *  then disposes their PTYs (via reconcile), so closing a background repo tab
   *  doesn't leave shells running with no UI to close them. No-op if absent. */
  closeRepoTerminals: (repoPath: string) => void;
}

function emptyRepo(): RepoTerminals {
  return { tabs: [], activeId: null, nextNumber: 1 };
}

export const useTerminals = create<TerminalsState>((set, get) => ({
  byRepo: {},

  openTab: (repoPath) => {
    const id = crypto.randomUUID();
    set((s) => {
      const repo = s.byRepo[repoPath] ?? emptyRepo();
      const title = `${repoLabel(repoPath)} ${repo.nextNumber}`;
      return {
        byRepo: {
          ...s.byRepo,
          [repoPath]: {
            tabs: [...repo.tabs, { id, title }],
            activeId: id,
            nextNumber: repo.nextNumber + 1,
          },
        },
      };
    });
    return id;
  },

  closeTab: (repoPath, id) => {
    const repo = get().byRepo[repoPath];
    if (!repo) return false; // nothing to close → don't signal "now empty"
    const index = repo.tabs.findIndex((t) => t.id === id);
    if (index === -1) return false; // unknown id → nothing closed, don't hide
    const tabs = repo.tabs.filter((t) => t.id !== id);
    let activeId = repo.activeId;
    if (activeId === id) {
      // Prefer the tab that took the closed one's slot, else its left neighbour.
      const next = tabs[index] ?? tabs[index - 1] ?? null;
      activeId = next?.id ?? null;
    }
    set((s) => ({
      byRepo: { ...s.byRepo, [repoPath]: { ...repo, tabs, activeId } },
    }));
    return tabs.length === 0;
  },

  setActiveTab: (repoPath, id) =>
    set((s) => {
      const repo = s.byRepo[repoPath];
      // Ignore unknown ids (stale caller) so a repo can't end up with an
      // activeId that points at no tab — which would show no active pane.
      if (!repo || repo.activeId === id || !repo.tabs.some((t) => t.id === id)) return s;
      return { byRepo: { ...s.byRepo, [repoPath]: { ...repo, activeId: id } } };
    }),

  ensureTab: (repoPath) => {
    const repo = get().byRepo[repoPath];
    if (repo && repo.tabs.length > 0) return repo.activeId ?? repo.tabs[0].id;
    return get().openTab(repoPath);
  },

  closeRepoTerminals: (repoPath) =>
    set((s) => {
      if (!(repoPath in s.byRepo)) return s;
      const { [repoPath]: _closed, ...rest } = s.byRepo;
      return { byRepo: rest };
    }),
}));
