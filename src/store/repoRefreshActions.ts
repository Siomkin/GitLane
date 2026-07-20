// Re-sync actions for the repo store (GL-158 split out of
// repoLifecycleActions.ts): the watcher/focus-driven `refresh` (worktree-scope
// and full), history paging, and the reflog read. Opening/closing repos lives
// in repoLifecycleActions.ts / repoTabActions.ts.

import { api } from "@/lib/api";
import { tabInfoFromSummary } from "@/lib/tabs";
import { useAccounts } from "./accounts";
import { mergeOperationStatus } from "./operation";
import { usePulls } from "./pulls";
import { reconcileFileDiff } from "./repoFileDiff";
import {
  flushPendingRefresh,
  graphRequestIsCurrent,
  repoStillDisplayed,
} from "./repoGuards";
import { createMissingRepoHandlers, errorText } from "./repoMissing";
import {
  beginGraphRequest,
  currentOpenIntent,
  deferRefresh,
  openIntentIsCurrent,
} from "./repoRequests";
import { loadSelectionUnion } from "./repoSelectionDiff";
import { persistTabInfo } from "./repoSession";
import { probeDirtyWorktrees } from "./repoWorktreeDirty";
import { useUi } from "./ui";
import { GRAPH_PAGE_SIZE, type RepoGet, type RepoSet, type RepoState } from "./repoTypes";

export function createRepoRefreshActions(
  set: RepoSet,
  get: RepoGet,
): Pick<
  RepoState,
  | "refresh"
  | "refreshWorktreeDirty"
  | "loadMoreHistory"
  | "loadReflog"
  | "searchHistory"
  | "suggestTreePaths"
> {
  const { wentMissing, handleMissing } = createMissingRepoHandlers(set, get);

  return {
    refreshWorktreeDirty: () => probeDirtyWorktrees(set, get, { force: true }),
    searchHistory: async (query) => {
      const repoPath = get().summary?.path;
      if (!repoPath) return { results: [], truncated: false, workTruncated: false };
      return api.searchHistory(repoPath, query);
    },
    suggestTreePaths: async (filter) => {
      const repoPath = get().summary?.path;
      if (!repoPath) return [];
      return api.suggestTreePaths(repoPath, filter);
    },
    refresh: async (opts) => {
      const { summary, graphLimit, loading } = get();
      if (!summary) return false;
      // The open-intent baseline for a missing-repo fallback (GL-126): captured
      // before any read below so a repo switch begun mid-refresh — which claims
      // a newer intent before its summary/generation publish — flips the
      // ownership token handed to the worktree fallback, even on the
      // parent-already-open synchronous path the generation guard can't see.
      const entryIntent = currentOpenIntent();
      // A load (or a manual refresh) holds `loading` while a graph is in flight.
      // Don't drop a watcher/focus re-sync that lands in that window — defer it,
      // keeping the most permissive scope, and replay once the blocker clears
      // (GL-20 review). A full re-sync also can't run concurrently here: it would
      // race the in-flight graph fetch and could livelock a slow initial open.
      if (loading) {
        deferRefresh(opts?.scope === "worktree" ? "worktree" : "all");
        return false;
      }
      const generation = opts?.scope === "worktree" ? null : beginGraphRequest();
      if (generation !== null) set({ loadingMoreHistory: false });
      if (!opts?.quiet) set({ loading: true, error: null });
      try {
        if (opts?.scope === "worktree") {
          // The operation status rides along with working changes so a watcher
          // event (terminal commit/checkout/rebase step) keeps the conflict
          // workspace truthful. Best-effort — degrade to "no operation".
          const [changes, opStatus] = await Promise.all([
            api.workingChanges(summary.path),
            api.operationStatus(summary.path).catch(() => null),
          ]);
          if (get().summary?.path !== summary.path) return false;
          const selectedFile = get().selectedFile;
          const selectedFileGone =
            selectedFile &&
            selectedFile.source !== "commit" &&
            !changes.staged.some((file) => file.path === selectedFile.path) &&
            !changes.unstaged.some((file) => file.path === selectedFile.path);
          const noWip =
            changes.staged.length === 0 &&
            changes.unstaged.length === 0 &&
            changes.conflicted.length === 0;
          set({
            changes,
            // Fold in a fresh operation status; on a detection failure, only
            // clear a stale `operation` when no conflicts remain in the worktree
            // (they survive in `changes.conflicted`), so a transient failure
            // mid-resolution doesn't yank the workspace out from under the user.
            operation: opStatus
              ? mergeOperationStatus(get().operation, opStatus)
              : changes.conflicted.length === 0
                ? null
                : get().operation,
            // A failed status read leaves the prior advisory untouched (avoid
            // flickering the banner on a transient error).
            operationAdvisory: opStatus ? opStatus.advisory || null : get().operationAdvisory,
            // Only clear the spinner if this call owned it (non-quiet). The quiet
            // watcher path never set it, so it must not clear a concurrent load's.
            ...(opts?.quiet ? {} : { loading: false }),
            ...(selectedFileGone ? { selectedFile: null, fileDiff: null } : {}),
            ...(get().wipSelected && noWip ? { wipSelected: false } : {}),
          });
          // The changes view has nothing to show over a clean tree — the ui
          // store falls back to the graph when it was the active view.
          if (noWip) useUi.getState().onWorkingTreeClean();
          // A working-tree comparison (head: null) reflects the live tree, so a
          // worktree-scope event (edit/stage/terminal commit) must refresh it.
          // Ref-to-ref comparisons are pinned to commits and don't change here.
          if (get().compare?.head === null) void get().refreshCompare();
          // The changed-files list updated above, but the file open in the diff
          // viewer (`fileDiff`) is a separate slice `refresh` doesn't touch — so
          // an external edit to it would stay stale until re-click. Refetch it
          // quietly; skip when it was just cleared as gone (GL-123).
          if (!selectedFileGone) void reconcileFileDiff(set, get, summary.path);
          // The Files-tab listing mirrors the worktree; reload it (quietly, the
          // old list stays visible) once it has been loaded at least once.
          if (get().repoFiles) void get().loadRepoFiles();
          // An open file viewer follows the worktree too — re-read it so an
          // external edit is reflected (closes itself if the file vanished).
          if (get().fileView) void get().reloadFileView();
          return true;
        }

        // Open first, alone: its classified rejection is what distinguishes a
        // repo whose path vanished mid-session from a real failure (GL-108), so
        // it must not race the other reads' plain string errors inside the
        // Promise.all (which rejects with whichever settles first). It's a
        // cheap in-process libgit2 metadata read — the serialization is free.
        const nextSummary = await api.openRepo(summary.path);
        const [graph, branches, worktrees, stashes, changes, forge, remotes, opStatus] =
          await Promise.all([
            api.commitGraph(summary.path, graphLimit),
            api.listBranches(summary.path),
            api.listWorktrees(summary.path).catch(() => []),
            api.listStashes(summary.path).catch(() => []),
            api.workingChanges(summary.path),
            api.repoForge(summary.path).catch(() => null),
            // A terminal `git remote add/remove` lands here via the watcher;
            // keep the remote list (and the per-remote account resolution
            // below) in step with it. Degrade to the previous list on failure.
            api.listRemotes(summary.path).catch(() => get().remotes),
            api.operationStatus(summary.path).catch(() => null),
          ]);
        if (generation === null || !graphRequestIsCurrent(get, generation, summary.path)) {
          // Superseded mid-flight: replay any sync deferred during this refresh's
          // loading window so the coalesced event isn't lost on this bail (GL-20).
          flushPendingRefresh(get);
          return false;
        }
        const currentSelection = get().selectedCommit;
        // Default to the newest real commit, skipping interleaved stash nodes (see
        // loadRepo).
        const selectedCommit =
          currentSelection && graph.commits.some((commit) => commit.id === currentSelection)
            ? currentSelection
            : graph.commits.find((commit) => !commit.stash)?.id ?? null;
        const commitFiles = selectedCommit ? await api.commitFiles(nextSummary.path, selectedCommit) : [];
        if (!graphRequestIsCurrent(get, generation, summary.path)) {
          flushPendingRefresh(get);
          return false;
        }
        // Trim the multi-selection to ids that still exist after the refresh —
        // e.g. a reset/rebase can drop the selected commits. Anchor stays if it
        // survives; otherwise it tracks the new focus commit.
        const liveIds = new Set(graph.commits.map((c) => c.id));
        const previousSelectedCommits = get().selectedCommits;
        const prevMulti = previousSelectedCommits.filter((id) => liveIds.has(id));
        const nextSelectedCommits =
          prevMulti.length > 0
            ? Array.from(new Set(selectedCommit ? [selectedCommit, ...prevMulti] : prevMulti))
            : selectedCommit
              ? [selectedCommit]
              : [];
        // Preserve reference identity when refresh reconciliation did not alter
        // the selected commit set. Refresh may put the focus first in its
        // candidate order, but that is not a user selection change. Batch writes use that identity as their
        // selection-owner token, so a deliberate A -> B -> A cycle (new array,
        // same values) cannot be mistaken for an untouched selection.
        const selectedCommits =
          previousSelectedCommits.length === nextSelectedCommits.length &&
          previousSelectedCommits.every((id) => nextSelectedCommits.includes(id))
            ? previousSelectedCommits
            : nextSelectedCommits;
        const selectionAnchor =
          get().selectionAnchor && liveIds.has(get().selectionAnchor!)
            ? get().selectionAnchor
            : selectedCommit;
        // Reconcile the merged-selection union with the (possibly trimmed)
        // selection: an unchanged commit *set* keeps its files (immutable by
        // oid); a changed set is reloaded; a collapse to ≤1 commit drops it.
        const prevDiff = get().selectionDiff;
        const multiNow = selectedCommits.length > 1;
        const sameSet =
          multiNow &&
          !!prevDiff &&
          prevDiff.commits.length === selectedCommits.length &&
          selectedCommits.every((id) => prevDiff.commits.includes(id));
        // Reuse the cached union only when the set is unchanged *and* it
        // succeeded — a stored error (or an in-flight load that errored) must be
        // retried on refresh, not carried forward until the user re-selects.
        const reuseUnion = sameSet && !prevDiff!.error;
        const selectionDiff = !multiNow
          ? null
          : reuseUnion
            ? // Same commit *set*: keep the files (immutable by oid) but adopt the
              // refreshed order so `selectionDiff.commits` can't drift from
              // `selectedCommits`.
              { ...prevDiff!, commits: selectedCommits }
            : { commits: selectedCommits, files: [], loading: true, error: null };
        // Drop a selected working-tree file that no longer has changes (e.g. it
        // was committed/discarded outside the app) so the diff pane can't go stale.
        const sel = get().selectedFile;
        const gone =
          sel &&
          sel.source !== "commit" &&
          !changes.staged.some((f) => f.path === sel.path) &&
          !changes.unstaged.some((f) => f.path === sel.path);
        // If the WIP node was selected but there are no more changes, drop it.
        // Conflicted paths count as changes so a conflict-only worktree keeps WIP.
        const noWip =
          changes.staged.length === 0 &&
          changes.unstaged.length === 0 &&
          changes.conflicted.length === 0;
        set({
          summary: nextSummary,
          // Keep the active tab's label truthful — a checkout (in-app or
          // terminal) changes the branch a worktree tab shows. Persisted below
          // so a restored session labels the tab correctly on first paint.
          tabInfoByPath: {
            ...get().tabInfoByPath,
            [nextSummary.path]: tabInfoFromSummary(nextSummary),
          },
          forge,
          remotes,
          graph,
          branches,
          worktrees,
          stashes,
          changes,
          // See the worktree-scope path above: clear a stale `operation` on a
          // detection failure only when no conflicts remain.
          operation: opStatus
            ? mergeOperationStatus(get().operation, opStatus)
            : changes.conflicted.length === 0
              ? null
              : get().operation,
          operationAdvisory: opStatus ? opStatus.advisory || null : get().operationAdvisory,
          selectedCommit,
          selectedCommits,
          selectionAnchor,
          selectionDiff,
          commitFiles,
          loading: false,
          // A refresh can supersede the initial open's graph request (e.g. a
          // checkout from the navigator while the skeleton is still up). When it
          // does, that orphaned load returns without clearing graphLoading, so
          // this owning refresh must clear it or the skeleton sticks (GL-20 review).
          graphLoading: false,
          ...(gone ? { selectedFile: null, fileDiff: null } : {}),
          ...(get().wipSelected && noWip ? { wipSelected: false } : {}),
        });
        // See the worktree-scope path above: a clean tree leaves the changes view.
        if (noWip) useUi.getState().onWorkingTreeClean();
        persistTabInfo(get().tabInfoByPath);
        // Pick up a worktree that appeared or vanished (the dirty dot's probe
        // fires on that, not on every refresh — this refresh is our own commit
        // or checkout, which can't have dirtied someone else's checkout).
        probeDirtyWorktrees(set, get);
        // The remote list may have changed (terminal `git remote add/remove`),
        // which changes what the per-remote bindings resolve to — re-sync before
        // the PR reload below so it fetches as the right account (GL-129).
        useAccounts.getState().syncRepoAccount(nextSummary.path);
        // The union needs (re)loading whenever we didn't reuse a healthy cached
        // one — set changed, or a prior error to retry. Fire-and-forget so it
        // doesn't delay the queue.
        if (multiNow && !reuseUnion) void loadSelectionUnion(set, get, nextSummary.path, selectedCommits);
        // Reconcile the open working-tree diff after a full refresh too — see the
        // worktree-scope path above; skip when the selection was cleared as gone (GL-123).
        if (!gone) void reconcileFileDiff(set, get, nextSummary.path);
        // A full refresh can move branch/commit tips, so re-run any open
        // comparison (ref-to-ref as well as working-tree) to keep it truthful.
        if (get().compare) void get().refreshCompare();
        // Keep the Files-tab listing in step with the refreshed worktree.
        if (get().repoFiles) void get().loadRepoFiles();
        // A full refresh follows a branch checkout (the graph moved) — re-read an
        // open file so it shows the new branch's version, or closes if gone.
        if (get().fileView) void get().reloadFileView();
        if (opts?.prs !== false) void usePulls.getState().loadPullRequests(false, true);
        // A non-quiet refresh held `loading`; replay anything deferred during it.
        flushPendingRefresh(get);
        return true;
      } catch (e) {
        if (generation !== null && !graphRequestIsCurrent(get, generation, summary.path)) {
          flushPendingRefresh(get);
          return false;
        }
        // A refresh failing because the repo's path vanished (deleted, or its
        // volume unmounted under an open tab) swaps in the missing-repo state
        // instead of the raw error (GL-108). Re-guard after the async probe —
        // a newer load may have replaced the displayed repo meanwhile.
        const missing = await wentMissing(summary.path, e);
        if (get().summary?.path === summary.path) {
          if (missing) {
            // A full refresh owns a graph generation; a worktree-scope re-sync
            // has none (generation === null), so fall back to the displayed-path
            // guard for it. Both are AND-ed with the open-intent baseline so an
            // in-flight switch that hasn't published yet still wins.
            await handleMissing(
              summary.path,
              missing,
              () =>
                openIntentIsCurrent(entryIntent) &&
                (generation !== null
                  ? graphRequestIsCurrent(get, generation, summary.path)
                  : repoStillDisplayed(get, summary.path)),
            );
          } else if (
            // Re-check ownership AFTER the async missing-probe: a newer
            // same-path refresh/load can begin during that await, and this
            // stale failure must not clear its spinner or overwrite its error.
            generation !== null
              ? graphRequestIsCurrent(get, generation, summary.path)
              : repoStillDisplayed(get, summary.path)
          ) {
            // When this refresh owns the graph request (generation !== null), clear
            // graphLoading too: it may have superseded the initial open, whose
            // orphaned load can't clear the skeleton itself (GL-20 review).
            // A quiet refresh never held `loading`, so it must not clear one.
            set({
              ...(opts?.quiet ? {} : { loading: false }),
              error: errorText(e),
              ...(generation !== null ? { graphLoading: false } : {}),
            });
          }
        }
        flushPendingRefresh(get);
        return false;
      }
    },

    loadMoreHistory: async () => {
      const { summary, graph, graphLimit, loading, loadingMoreHistory } = get();
      if (!summary || !graph?.truncated || loading || loadingMoreHistory) return;
      const nextLimit = graphLimit + GRAPH_PAGE_SIZE;
      const generation = beginGraphRequest();
      set({ loadingMoreHistory: true, loading: false });
      try {
        const nextGraph = await api.commitGraph(summary.path, nextLimit);
        if (!graphRequestIsCurrent(get, generation, summary.path)) return;
        set({
          graph: nextGraph,
          graphLimit: nextLimit,
          loadingMoreHistory: false,
        });
      } catch (error) {
        if (!graphRequestIsCurrent(get, generation, summary.path)) return;
        set({ loadingMoreHistory: false });
        useUi.getState().showToast(String(error), "error");
      }
    },

    loadReflog: async () => {
      const { summary } = get();
      if (!summary) return;
      set({ reflogLoading: true, reflogError: null });
      try {
        const reflogEntries = await api.listReflog(summary.path, 120);
        if (get().summary?.path !== summary.path) return;
        set({ reflogEntries, reflogLoading: false });
      } catch (e) {
        if (get().summary?.path !== summary.path) return;
        set({ reflogLoading: false, reflogError: String(e) });
      }
    },
  };
}
