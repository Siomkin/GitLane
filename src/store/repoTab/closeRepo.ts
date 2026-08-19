// Closing a repo tab: releasing its watch/terminals, and either landing on a
// neighbour tab or resetting to the welcome screen when none remain.

import { pruneTabInfo } from "@/lib/tabs";
import { neighbourTabPath } from "./tabOrder";
import { usePulls } from "@/store/pulls";
import { beginPublishedRepoSession, endTabLifetime } from "@/store/repoRequests";
import { persistSession, persistTabInfo, readLastPath } from "@/store/repoSession";
import { unwatchRepo } from "@/store/repoWatchQueue";
import { useTerminals } from "@/store/terminals";
import { useUi } from "@/store/ui";
import {
  repoDataWipe,
  type RepoGet,
  type RepoSet,
  type RepoState,
} from "@/store/repoTypes";

export function createCloseRepoAction(set: RepoSet, get: RepoGet): Pick<RepoState, "closeRepo"> {
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
        const next = neighbourTabPath(openPaths, get().tabInfoByPath, path);
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
          ...repoDataWipe([]),
          // Carried across: the transport still owns live remote-ref work after
          // its tab closes, and only its settle handler may clear that owner —
          // clearing `fetchingPath` here would let a newly opened repo start a
          // conflicting transport while git is still busy. The loading flags,
          // unlike `fetchingPath`, are cleared by the wipe: closing the tab
          // orphans any in-flight graph request (its summary-path guard now
          // fails), so it can't clear them itself and `loading` would
          // otherwise stick true (GL-20 review).
          fetchingPath: get().fetchingPath,
          netOps: get().netOps,
          sessionRestorePhase: get().sessionRestorePhase,
          initMissingRepoRunning: get().initMissingRepoRunning,
          recents: get().recents,
          fileSelectionRequestId: get().fileSelectionRequestId,
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
      const next = neighbourTabPath(openPaths, get().tabInfoByPath, path) ?? remaining[0];
      // Remove the closing repo's data before the replacement load. If opening
      // the neighbour fails, the UI shows a clean error state rather than keeping
      // a summary whose tab no longer exists.
      beginPublishedRepoSession();
      set({
        ...repoDataWipe(remaining),
        tabInfoByPath: pruneTabInfo(get().tabInfoByPath, remaining),
        // Carried across for the same reasons as the last-tab close above; the
        // wipe's loading-flag reset is what keeps a failed replacement load
        // from sticking the closed tab's flags (GL-20 review).
        fetchingPath: get().fetchingPath,
        netOps: get().netOps,
        sessionRestorePhase: get().sessionRestorePhase,
        initMissingRepoRunning: get().initMissingRepoRunning,
        recents: get().recents,
        fileSelectionRequestId: get().fileSelectionRequestId,
      });
      persistSession(remaining, next);
      persistTabInfo(pruneTabInfo(get().tabInfoByPath, remaining));
      await get().loadRepo(next);
    },
  };
}
