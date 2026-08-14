// Launch-time session restore: probing the persisted tabs on disk, reconciling
// them against the strip that exists now, and activating the last active repo.

import { api } from "@/lib/api";
import { pruneTabInfo, tabInfoFromStatus } from "@/lib/tabs";
import {
  endTabLifetime,
  ensureTabLifetime,
  openIntent,
  tabLifetimeIsCurrent,
} from "@/store/repoRequests";
import { persistSession, persistTabInfo, readLastPath } from "@/store/repoSession";
import { unwatchRepo, watchRepo } from "@/store/repoWatchQueue";
import {
  SESSION_RESTORE_PHASE,
  type RepoGet,
  type RepoSet,
  type RepoState,
} from "@/store/repoTypes";

export function createRestoreSessionAction(
  set: RepoSet,
  get: RepoGet,
): Pick<RepoState, "restoreSession"> {
  return {
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
  };
}
