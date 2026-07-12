// Tab-strip, session, and recents actions for the repo store (GL-158 split out
// of repoLifecycleActions.ts): closing/reordering tabs, restoring the last
// session, and keeping tab labels + the recents list truthful. Opening a repo
// (loadRepo and the missing-repo recovery entry points) stays in
// repoLifecycleActions.ts; these actions delegate to it via `get()`.

import { arrayMove } from "@dnd-kit/helpers";
import { api } from "../lib/api";
import { pruneTabInfo, tabInfoFromStatus } from "../lib/tabs";
import { usePulls } from "./pulls";
import {
  persistRecents,
  persistSession,
  persistTabInfo,
  readLastPath,
} from "./repoSession";
import { unwatchRepo, watchRepo } from "./repoWatchQueue";
import { useTerminals } from "./terminals";
import { useUi } from "./ui";
import {
  emptyChanges,
  INITIAL_GRAPH_LIMIT,
  type RepoGet,
  type RepoSet,
  type RepoState,
} from "./repoTypes";

export function createRepoTabActions(
  set: RepoSet,
  get: RepoGet,
): Pick<
  RepoState,
  | "closeRepo"
  | "reorderOpenPaths"
  | "restoreSession"
  | "refreshTabInfo"
  | "refreshRecents"
  | "removeRecent"
  | "clearRecents"
> {
  return {
    // Close a repo tab. If it was the active one, switch to a neighbour, or fall
    // back to the welcome screen when none remain.
    closeRepo: async (path) => {
      const { openPaths, summary } = get();
      const remaining = openPaths.filter((p) => p !== path);
      // Every open tab holds a filesystem watch (GL-116); closing the tab is
      // what releases it, whichever branch below handles the tab itself.
      // Sequenced per path so an immediate reopen's watch can't be reordered
      // ahead of this unwatch (GL-125).
      void unwatchRepo(path);
      // Closing a repo tab closes its terminals too: drop this repo's tab
      // metadata so the panes manager disposes their PTYs (otherwise a
      // background-repo close would leave shells running with no UI). Keyed by
      // the same identity path as `openPaths`.
      useTerminals.getState().closeRepoTerminals(path);
      // Closing the missing-repo tab (its X, or Remove on the screen): the repo
      // data was already cleared when the state was entered, so just drop the
      // tab + state and land on a neighbour or the welcome screen (GL-108).
      if (get().missingRepo?.path === path) {
        const next = remaining[Math.max(0, openPaths.indexOf(path) - 1)] ?? remaining[0] ?? null;
        const prunedInfo = pruneTabInfo(get().tabInfoByPath, remaining);
        set({ openPaths: remaining, missingRepo: null, tabInfoByPath: prunedInfo });
        persistSession(remaining, next);
        persistTabInfo(prunedInfo);
        // A neighbour switch resets the view via loadRepo; dropping to the
        // welcome screen is a repo switch too, so reset here.
        if (next) await get().loadRepo(next);
        else useUi.getState().onRepoSwitched();
        return;
      }
      const wasActive = summary?.path === path;
      if (!wasActive) {
        // `summary` can legitimately be null here (a missing-repo tab is the
        // active one) — keep the persisted lastPath rather than wiping it.
        const prunedInfo = pruneTabInfo(get().tabInfoByPath, remaining);
        persistSession(remaining, summary?.path ?? readLastPath());
        persistTabInfo(prunedInfo);
        set({ openPaths: remaining, tabInfoByPath: prunedInfo });
        return;
      }
      if (remaining.length === 0) {
        persistSession([], null);
        persistTabInfo({});
        set({
          openPaths: [],
          tabInfoByPath: {},
          summary: null,
          // `forge` keys the provider indicator independently of `summary`, so a
          // leak here would render a stale indicator on the welcome screen.
          forge: null,
          remotes: [],
          graph: null,
          branches: [],
          reflogEntries: [],
          reflogLoading: false,
          reflogError: null,
          worktrees: [],
          changes: emptyChanges,
          operation: null,
          operationAdvisory: null,
          commitFiles: [],
          selectionDiff: null,
          selectedCommit: null,
          selectedCommits: [],
          selectionAnchor: null,
          revealTarget: null,
          graphLimit: INITIAL_GRAPH_LIMIT,
          // Clear the loading flags: closing the tab orphans any in-flight graph
          // request (its summary-path guard now fails), so it can't clear them
          // itself and `loading` would otherwise stick true (GL-20 review).
          loading: false,
          graphLoading: false,
          loadingMoreHistory: false,
          selectedFile: null,
          fileDiff: null,
          fileHistory: null,
          compare: null,
          repoFiles: null,
          fileView: null,
        });
        usePulls.getState().reset();
        // Closing the last tab drops to the welcome screen; reset the view and
        // clear any open repo-bound overlay (destructive confirm, reflog-recovery
        // dialog, prompt, hand-off, or delete-branch-and-worktree dialog) — all
        // bound to the now-closed repo. The switch-to-neighbour branch below
        // routes through `loadRepo`, which already does this. GL-42 / GL-107.
        useUi.getState().onRepoSwitched();
        useUi.getState().closeConfirm();
        useUi.getState().closeRecovery();
        useUi.getState().closePrompt();
        useUi.getState().closeHandoff();
        useUi.getState().closeDeleteWorktree();
        return;
      }
      const next = remaining[Math.max(0, openPaths.indexOf(path) - 1)] ?? remaining[0];
      // Remove the closing repo's data before the replacement load. If opening
      // the neighbour fails, the UI shows a clean error state rather than keeping
      // a summary whose tab no longer exists.
      set({
        openPaths: remaining,
        tabInfoByPath: pruneTabInfo(get().tabInfoByPath, remaining),
        summary: null,
        forge: null,
        remotes: [],
        graph: null,
        branches: [],
        reflogEntries: [],
        reflogLoading: false,
        reflogError: null,
        worktrees: [],
        stashes: [],
        changes: emptyChanges,
        operation: null,
        operationAdvisory: null,
        commitFiles: [],
        selectionDiff: null,
        selectedCommit: null,
        selectedCommits: [],
        selectionAnchor: null,
        revealTarget: null,
        graphLimit: INITIAL_GRAPH_LIMIT,
        // Reset the loading flags before the replacement load: the closing tab's
        // in-flight graph request is now orphaned, and if loadRepo(next) fails at
        // open_repo its phase-1 catch only sets `error`, so these would otherwise
        // stay stuck from the closed tab (GL-20 review).
        loading: false,
        graphLoading: false,
        loadingMoreHistory: false,
        selectedFile: null,
        fileDiff: null,
        fileHistory: null,
        compare: null,
        repoFiles: null,
        fileView: null,
      });
      persistSession(remaining, next);
      persistTabInfo(pruneTabInfo(get().tabInfoByPath, remaining));
      await get().loadRepo(next);
    },

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

    // On launch, reopen the last active repository (tabs are restored from
    // localStorage in the initial state). Before reopening, probe the restored
    // tabs on disk. A since-removed *worktree* tab (e.g. a pruned agent
    // worktree) is dropped instead of restoring dead (GL-109) — worktree-ness
    // comes from the persisted tab info, since the gone path can't answer. A
    // missing *repository* keeps its tab and restores into the GL-108 recovery
    // screen (Retry is a real path for unmounted volumes). Surviving worktree
    // tabs refresh their identity info (parent repo + branch) for
    // labels/grouping before their first activation (GL-110).
    restoreSession: async () => {
      let last = readLastPath();
      const restored = get().openPaths;
      if (restored.length > 0) {
        try {
          const statuses = await api.recentsStatus(restored);
          const byPath = new Map(statuses.map((s) => [s.path, s]));
          const prevInfo = get().tabInfoByPath;
          // Drop only what the probe positively reported gone AND the persisted
          // info knows was a worktree; a path the probe didn't answer for keeps
          // its tab (defensive — a short result must not wipe the strip).
          const openPaths = restored.filter((path) => {
            const status = byPath.get(path);
            return !status || status.exists || !prevInfo[path]?.isWorktree;
          });
          const tabInfoByPath = Object.fromEntries(
            openPaths.map((path) => {
              const status = byPath.get(path);
              // A kept-but-missing repo tab holds on to its last-known info so
              // its label survives until Retry/Locate resolves it.
              const info =
                status?.exists ? tabInfoFromStatus(status) : prevInfo[path];
              return [path, info ?? { isWorktree: false, mainPath: null, branch: null }];
            }),
          );
          // The last-active path may be among the dropped worktrees — heal to
          // the first *live* survivor (falling back to a missing repo tab,
          // which restores into its recovery screen) rather than reopening a
          // gone directory.
          if (last && !openPaths.includes(last)) {
            last =
              openPaths.find((p) => byPath.get(p)?.exists) ?? openPaths[0] ?? null;
          }
          persistSession(openPaths, last);
          persistTabInfo(tabInfoByPath);
          set({ openPaths, tabInfoByPath });
          // Background tabs are never load-ed until activated, so give each
          // surviving live path its watch now (GL-116) — the active one is
          // (re-)watched by loadRepo below; re-inserting the key is harmless.
          for (const path of openPaths) {
            if (path !== last && byPath.get(path)?.exists) {
              void watchRepo(path);
            }
          }
        } catch {
          // Probe failure: keep the restored tabs — a truly dead last path
          // still surfaces through loadRepo's classified open below.
        }
      }
      if (last) await get().loadRepo(last);
    },

    // A background tab's watcher fired: re-probe the path so its tab label
    // (branch, worktree identity) stays live without loading the repo — the
    // full data reload still happens on activation (loadRepo). Best-effort;
    // a probe failure keeps the last-known label.
    refreshTabInfo: async (path) => {
      try {
        const [status] = await api.recentsStatus([path]);
        if (!status?.exists) return;
        // Re-check after the await: the tab may have closed while probing.
        if (!get().openPaths.includes(path)) return;
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
          return status
            ? { ...r, missing: !status.exists, branch: status.exists ? status.branch : r.branch }
            : r;
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
