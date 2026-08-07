// Tab-strip, session, and recents actions for the repo store (GL-158 split out
// of repoLifecycleActions.ts): closing/reordering tabs, restoring the last
// session, and keeping tab labels + the recents list truthful. Opening a repo
// (loadRepo and the missing-repo recovery entry points) stays in
// repoLifecycleActions.ts; these actions delegate to it via `get()`.

import { arrayMove } from "@dnd-kit/helpers";
import { api } from "@/lib/api";
import { pruneTabInfo, tabInfoFromStatus } from "@/lib/tabs";
import { usePulls } from "./pulls";
import {
  beginPublishedRepoSession,
  endTabLifetime,
  ensureTabLifetime,
  openIntent,
  tabLifetimeIsCurrent,
} from "./repoRequests";
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
  SESSION_RESTORE_PHASE,
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
      // Invalidate this exact tab before any await or persisted/UI mutation.
      // A pending activation/label probe then cannot resurrect or publish into
      // the same-path tab after it is closed and reopened.
      endTabLifetime(path);
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
      useUi.getState().forgetTerminalView(path);
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
      // During close-active → load-neighbour phase 1 the old summary is already
      // cleared, but the persisted last path identifies the neighbour whose
      // activation owns the empty shell. Closing that pending neighbour is an
      // active close too: clear the last path and run the full welcome cleanup
      // instead of persisting a now-closed path as active.
      const wasActive =
        summary?.path === path ||
        (!summary && !get().missingRepo && readLastPath() === path);
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
        beginPublishedRepoSession();
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
          dirtyWorktrees: [],
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
          // `fetchingPath` is deliberately different: the transport still owns
          // live remote-ref work after its tab closes, and only its settle
          // handler may clear that owner. Clearing it here would let a newly
          // opened repo start a conflicting transport while git is still busy.
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
        // The last tab closed: nothing repo-bound may survive, including a
        // hand-off whose own worktree just went with it (GL-358).
        useUi.getState().onRepoSwitched({ dropRunningHandoff: true });
        return;
      }
      const next = remaining[Math.max(0, openPaths.indexOf(path) - 1)] ?? remaining[0];
      // Remove the closing repo's data before the replacement load. If opening
      // the neighbour fails, the UI shows a clean error state rather than keeping
      // a summary whose tab no longer exists.
      beginPublishedRepoSession();
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
        dirtyWorktrees: [],
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
      // React Strict Mode re-runs launch effects in development. Claim the
      // restore synchronously so the second invocation cannot duplicate the
      // disk probe/open or finish early and reveal onboarding mid-restore.
      if (get().sessionRestorePhase !== SESSION_RESTORE_PHASE.Pending) return;
      set({ sessionRestorePhase: SESSION_RESTORE_PHASE.Restoring });

      const restored = [...get().openPaths];
      const restoredInfo = get().tabInfoByPath;
      const restoredOwners = new Map(
        restored.map((path) => [path, ensureTabLifetime(path)]),
      );
      const persistedLast = readLastPath();
      // A user-initiated open claims this token before its phase-1 disk read.
      // Capture it before our own probe so even a still-pending navigation can
      // stop startup restore from pruning its target or reopening another tab.
      const restoreIntent = openIntent.current();

      try {
        let byPath: Map<
          string,
          Awaited<ReturnType<typeof api.recentsStatus>>[number]
        > | null = null;
        if (restored.length > 0) {
          try {
            const statuses = await api.recentsStatus(restored);
            byPath = new Map(statuses.map((status) => [status.path, status]));
          } catch {
            // Probe failure: keep the restored tabs — a truly dead last path
            // still surfaces through loadRepo's classified open below.
          }
        }

        // Reconcile into the strip that exists *now*, never the startup snapshot:
        // closes, reorders, and newly-opened tabs that happened during the disk
        // probe keep their current membership and order. Statuses only own the
        // exact original tab lifetime + metadata object. The object-identity
        // check lets a newer activation/refreshTabInfo win even when the tab was
        // never closed and therefore retained its lifetime.
        const currentPaths = get().openPaths;
        const currentInfo = get().tabInfoByPath;
        const intentUnchanged = openIntent.current() === restoreIntent;
        const nextInfo = { ...currentInfo };
        const pruned = new Set<string>();
        const watchable = new Set<string>();

        if (byPath) {
          for (const path of currentPaths) {
            const owner = restoredOwners.get(path);
            if (
              !owner ||
              !tabLifetimeIsCurrent(owner) ||
              currentInfo[path] !== restoredInfo[path]
            ) {
              continue;
            }

            const status = byPath.get(path);
            // A newer open can still be in phase 1 with the target's lifetime and
            // info unchanged. Without a per-path pending-open token we therefore
            // make pruning conditional on the *global* navigation intent too.
            if (
              intentUnchanged &&
              status &&
              !status.exists &&
              restoredInfo[path]?.isWorktree
            ) {
              pruned.add(path);
              continue;
            }

            if (status?.exists) {
              nextInfo[path] = tabInfoFromStatus(status);
              watchable.add(path);
            } else if (!nextInfo[path]) {
              // A kept-but-missing repo tab (or an omitted probe result) retains
              // its last-known label, falling back to a plain repository tab.
              nextInfo[path] =
                restoredInfo[path] ?? {
                  isWorktree: false,
                  mainPath: null,
                  branch: null,
                };
            }
          }
        }

        const openPaths = currentPaths.filter((path) => !pruned.has(path));
        const tabInfoByPath = pruneTabInfo(nextInfo, openPaths);

        // Retire and unwatch only paths this exact restore lease positively
        // pruned. User closes already ended/unwatched their own lifetime, and a
        // same-path reopen carries a different lease that must remain untouched.
        for (const path of pruned) {
          const owner = restoredOwners.get(path);
          if (
            owner &&
            tabLifetimeIsCurrent(owner) &&
            get().tabInfoByPath[path] === restoredInfo[path]
          ) {
            endTabLifetime(path);
            void unwatchRepo(path);
          }
        }

        const liveLast = readLastPath();
        const restoreStillOwnsNavigation =
          intentUnchanged && liveLast === persistedLast && persistedLast !== null;
        let autoOpenTarget: string | null = null;
        if (restoreStillOwnsNavigation) {
          const lastOwner = restoredOwners.get(persistedLast);
          if (
            lastOwner &&
            tabLifetimeIsCurrent(lastOwner) &&
            openPaths.includes(persistedLast)
          ) {
            autoOpenTarget = persistedLast;
          } else if (restored.length === 0) {
            // Partial storage can retain only the active path. With no restored
            // strip there is no tab lease to capture, so the unchanged global
            // intent + unchanged persisted value are the ownership proof; let
            // loadRepo publish it as a genuinely new tab as before.
            autoOpenTarget = persistedLast;
          } else {
            // The old active tab was retired without a newer navigation (most
            // commonly a dead restored worktree). Heal to an exact surviving
            // startup tab, preferring one the probe positively found on disk.
            const survivingRestored = openPaths.filter((path) => {
              const owner = restoredOwners.get(path);
              return owner && tabLifetimeIsCurrent(owner);
            });
            autoOpenTarget =
              survivingRestored.find((path) => byPath?.get(path)?.exists) ??
              survivingRestored[0] ??
              null;
          }
        }

        // A completed newer navigation may already have persisted a different
        // active path. Read it at publication time and keep it verbatim; only
        // this still-owned restore may heal its retired startup last path.
        const sessionLast = restoreStillOwnsNavigation ? autoOpenTarget : liveLast;
        persistSession(openPaths, sessionLast);
        persistTabInfo(tabInfoByPath);
        set({ openPaths, tabInfoByPath });

        // Background tabs are never load-ed until activated, so watch only live,
        // exact reconciled owners that the probe found. New/reopened tabs and the
        // active repo own their watches through their newer loadRepo lifecycle.
        for (const path of watchable) {
          const owner = restoredOwners.get(path);
          if (
            path !== autoOpenTarget &&
            path !== get().summary?.path &&
            openPaths.includes(path) &&
            owner &&
            tabLifetimeIsCurrent(owner)
          ) {
            void watchRepo(path);
          }
        }

        // Re-check immediately before activation. No startup result may override
        // a navigation claimed after the probe, or load a closed/reopened tab
        // merely because the same path string appears in the strip again.
        if (autoOpenTarget) {
          const owner = restoredOwners.get(autoOpenTarget);
          const ownsLastOnlyRestore =
            restored.length === 0 && autoOpenTarget === persistedLast;
          if (
            openIntent.current() === restoreIntent &&
            readLastPath() === autoOpenTarget &&
            (ownsLastOnlyRestore ||
              (get().openPaths.includes(autoOpenTarget) &&
                owner &&
                tabLifetimeIsCurrent(owner)))
          ) {
            await get().loadRepo(autoOpenTarget);
          }
        }
      } finally {
        set({ sessionRestorePhase: SESSION_RESTORE_PHASE.Complete });
      }
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
