// Re-sync actions for the repo store (GL-158 split out of
// repoLifecycleActions.ts): the watcher/focus-driven `refresh` (worktree-scope
// and full), history paging, and the reflog read. Opening/closing repos lives
// in repoLifecycleActions.ts / repoTabActions.ts.

import { api } from "@/lib/api";
import { tabInfoFromSummary } from "@/lib/tabs";
import { reconcileGraphSelection } from "./repoGraphReconcile";
import {
  flushPendingRefresh,
  graphRequestIsCurrent,
  readRequestIsCurrent,
  repoSessionIsCurrent,
} from "./repoGuards";
import { claimLaneFailure } from "./repoRefresh/laneFailures";
import { createRepoHistoryPaging } from "./repoRefresh/history";
import { planRefreshPublication } from "./repoRefresh/publish";
import { refreshWorktreeScope } from "./repoRefresh/worktreeScope";
import { createMissingRepoHandlers, errorText } from "./repoMissing";
import {
  beginMetadataRequest,
  beginRemotesRequest,
  deferRefresh,
  graphRequests,
  metadataRequests,
  openIntent,
  publishedRepoSession,
  requestPrPrefetch,
  worktreeRequests,
} from "./repoRequests";
import { loadSelectionUnion } from "./repoSelectionDiff";
import { fetchInspectFileList } from "./repoSelection/inspectFiles";
import { persistTabInfo } from "./repoSession";
import { probeDirtyWorktrees } from "./repoWorktreeDirty";
import { type RepoGet, type RepoSet, type RepoState } from "./repoTypes";

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
  const { wentMissing, handleMissing, surfaceOpenFailure } = createMissingRepoHandlers(set, get);

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
      const entryIntent = openIntent.current();
      // A load (or a manual refresh) holds `loading` while a graph is in flight.
      // Don't drop a watcher/focus re-sync that lands in that window — defer it,
      // keeping the most permissive scope, and replay once the blocker clears
      // (GL-20 review). A full re-sync also can't run concurrently here: it would
      // race the in-flight graph fetch and could livelock a slow initial open.
      if (loading) {
        deferRefresh(opts?.scope === "worktree" ? "worktree" : "all");
        return false;
      }
      const session = publishedRepoSession.current();
      const worktreeOwner = {
        path: summary.path,
        session,
        generation: worktreeRequests.claim(),
      };
      const generation = opts?.scope === "worktree" ? null : graphRequests.claim();
      const metadataOwner =
        generation === null
          ? null
          : { path: summary.path, session, generation: beginMetadataRequest() };
      const remotesOwner =
        generation === null
          ? null
          : { path: summary.path, session, generation: beginRemotesRequest() };
      if (generation !== null && opts?.prs !== false) requestPrPrefetch(session);
      if (generation !== null) set({ loadingMoreHistory: false });
      if (!opts?.quiet) set({ loading: true, error: null });
      try {
        if (opts?.scope === "worktree") {
          return refreshWorktreeScope(set, get, summary.path, opts, worktreeOwner);
        }

        // Open first, alone: its classified rejection is what distinguishes a
        // repo whose path vanished mid-session from a real failure (GL-108), so
        // it must not race the other reads' plain string errors inside the
        // Promise.all (which rejects with whichever settles first). It's a
        // cheap in-process libgit2 metadata read — the serialization is free.
        const fallbackRemotes = get().remotes;
        const nextSummary = await api.openRepo(summary.path);
        const [graphResult, branchesResult, worktrees, stashes, changesResult, forge, remotes, opStatus] =
          await Promise.all([
            api.commitGraph(summary.path, graphLimit).then(
              (value) => ({ status: "fulfilled" as const, value }),
              (reason: unknown) => ({ status: "rejected" as const, reason }),
            ),
            api.listBranches(summary.path).then(
              (value) => ({ status: "fulfilled" as const, value }),
              (reason: unknown) => ({ status: "rejected" as const, reason }),
            ),
            api.listWorktrees(summary.path).catch(() => []),
            api.listStashes(summary.path).catch(() => []),
            api
              .workingChanges(summary.path)
              .then(
                (value) => ({ status: "fulfilled" as const, value }),
                (reason: unknown) => ({ status: "rejected" as const, reason }),
              ),
            api.repoForge(summary.path).catch(() => null),
            // A terminal `git remote add/remove` lands here via the watcher;
            // keep the remote list (and the per-remote account resolution
            // below) in step with it. Degrade to the previous list on failure.
            api.listRemotes(summary.path).catch(() => fallbackRemotes),
            api.operationStatus(summary.path).catch(() => null),
          ]);
        const selectionOwner = {
          requestId: get().fileSelectionRequestId,
          selectedCommit: get().selectedCommit,
          selectedCommits: get().selectedCommits,
        };
        // Required metadata failure is classified independently from graph,
        // worktree and remotes. Metadata wins deterministic error precedence if
        // both required secondary reads reject in the same full refresh.
        const metadataFailure = await claimLaneFailure(
          branchesResult,
          summary.path,
          () => metadataOwner !== null && readRequestIsCurrent(get, metadataRequests, metadataOwner),
          wentMissing,
          handleMissing,
          () => openIntent.isCurrent(entryIntent),
        );
        if (metadataFailure.transitioned) {
          flushPendingRefresh(get);
          return false;
        }
        // Keep the required working-changes rejection settled until every
        // independent lane has completed. If a newer worktree request already
        // superseded it, this refresh may still publish its graph, metadata and
        // remotes instead of losing them to Promise.all rejection.
        const worktreeFailure = await claimLaneFailure(
          changesResult,
          summary.path,
          () => readRequestIsCurrent(get, worktreeRequests, worktreeOwner),
          wentMissing,
          handleMissing,
          () => openIntent.isCurrent(entryIntent),
        );
        if (worktreeFailure.transitioned) {
          flushPendingRefresh(get);
          return false;
        }
        const changes =
          changesResult.status === "fulfilled" ? changesResult.value : get().changes;
        const branches =
          branchesResult.status === "fulfilled" ? branchesResult.value : get().branches;
        const graphFailure = await claimLaneFailure(
          graphResult,
          summary.path,
          () => generation !== null && graphRequestIsCurrent(get, generation, summary.path),
          wentMissing,
          handleMissing,
          () => openIntent.isCurrent(entryIntent),
        );
        if (graphFailure.transitioned) {
          flushPendingRefresh(get);
          return false;
        }

        const {
          graphCurrent,
          metadataCurrent,
          worktreeCurrent,
          remotesCurrent,
          secondaryPatch,
          metadataFailureCurrent,
          worktreeFailureCurrent,
          graphFailureCurrent,
          hasOwnedFailure,
          ownedFailure,
          publishSecondaryEffects,
          worktreeReconciliation,
        } = planRefreshPublication(set, get, summary, {
          generation,
          session,
          entryIntent,
          metadataOwner,
          worktreeOwner,
          remotesOwner,
          branchesResult,
          changesResult,
          changes,
          branches,
          forge,
          worktrees,
          stashes,
          remotes,
          opStatus,
          metadataFailure,
          worktreeFailure,
          graphFailure,
        });

        if (graphResult.status !== "fulfilled" || !graphCurrent) {
          set({
            ...secondaryPatch,
            ...(graphFailureCurrent
              ? {
                  ...(opts?.quiet ? {} : { loading: false }),
                  graphLoading: false,
                }
              : {}),
            ...(hasOwnedFailure && openIntent.isCurrent(entryIntent)
              ? { error: errorText(ownedFailure) }
              : {}),
          });
          publishSecondaryEffects();
          flushPendingRefresh(get);
          return (
            !graphFailureCurrent &&
            !metadataFailureCurrent &&
            !worktreeFailureCurrent &&
            (metadataCurrent || worktreeCurrent || remotesCurrent)
          );
        }
        const graph = graphResult.value;
        const liveSelection = {
          requestId: get().fileSelectionRequestId,
          selectedCommit: get().selectedCommit,
          selectedCommits: get().selectedCommits,
          selectionAnchor: get().selectionAnchor,
          selectionDiff: get().selectionDiff,
          selectedFile: get().selectedFile,
          // The worktree lane above may have just cleared the WIP row (tree went
          // clean); its patch publishes with this one, so read the new value.
          wipSelected:
            worktreeCurrent && worktreeReconciliation.noWip ? false : get().wipSelected,
        };
        const selectionReconciliation = reconcileGraphSelection({
          graph,
          selectionOwner,
          liveSelection,
          repoSessionCurrent: repoSessionIsCurrent(get, summary.path, session),
        });
        set({
          summary: nextSummary,
          // Keep the active tab's label truthful — a checkout (in-app or
          // terminal) changes the branch a worktree tab shows. Persisted below
          // so a restored session labels the tab correctly on first paint.
          tabInfoByPath: {
            ...get().tabInfoByPath,
            [nextSummary.path]: tabInfoFromSummary(nextSummary),
          },
          graph,
          ...secondaryPatch,
          ...selectionReconciliation.patch,
          ...(opts?.quiet ? {} : { loading: false }),
          // A refresh can supersede the initial open's graph request (e.g. a
          // checkout from the navigator while the skeleton is still up). When it
          // does, that orphaned load returns without clearing graphLoading, so
          // this owning refresh must clear it or the skeleton sticks (GL-20 review).
          graphLoading: false,
          ...(hasOwnedFailure && openIntent.isCurrent(entryIntent)
            ? { error: errorText(ownedFailure) }
            : {}),
        });
        persistTabInfo(get().tabInfoByPath);
        // Pick up a worktree that appeared or vanished (the dirty dot's probe
        // fires on that, not on every refresh — this refresh is our own commit
        // or checkout, which can't have dirtied someone else's checkout). Gated
        // on the metadata lane because that lane is what published `worktrees`
        // above; a superseded metadata read must not probe for this repo.
        // (`syncRepoAccount` used to sit here too — it now runs inside
        // `publishSecondaryEffects` under the remotes lane that owns it.)
        if (metadataCurrent) probeDirtyWorktrees(set, get);
        // The union needs (re)loading whenever we didn't reuse a healthy cached
        // one — set changed, or a prior error to retry. Fire-and-forget so it
        // doesn't delay the queue.
        if (
          selectionReconciliation.publishSelection &&
          selectionReconciliation.multiNow &&
          !selectionReconciliation.reuseUnion
        ) {
          void loadSelectionUnion(
            set,
            get,
            nextSummary.path,
            selectionReconciliation.selectedCommits,
            selectionReconciliation.workingBase,
          );
        }
        if (selectionReconciliation.selectionCommitToLoad) {
          const selectionCommitToLoad = selectionReconciliation.selectionCommitToLoad;
          const parentIndex = get().inspectParentIndex;
          const fallbackIsCurrent = () =>
            repoSessionIsCurrent(get, nextSummary.path, session) &&
            get().fileSelectionRequestId ===
              selectionReconciliation.publishedSelectionRequestId &&
            get().selectedCommit === selectionCommitToLoad &&
            get().inspectParentIndex === parentIndex;
          void fetchInspectFileList(
            nextSummary.path,
            selectionCommitToLoad,
            parentIndex,
            get().graph,
          )
            .then((files) => {
              if (fallbackIsCurrent()) set({ commitFiles: files, diffLoading: false });
            })
            .catch(async (error) => {
              if (!fallbackIsCurrent()) return;
              await surfaceOpenFailure(
                nextSummary.path,
                error,
                () => openIntent.isCurrent(entryIntent) && fallbackIsCurrent(),
              );
              if (fallbackIsCurrent()) set({ diffLoading: false });
            });
        }
        publishSecondaryEffects();
        // Ref-to-ref comparison is graph-owned and does not depend on the
        // working-tree lane.
        if (get().compare && get().compare?.head !== null) void get().refreshCompare();
        // A non-quiet refresh held `loading`; replay anything deferred during it.
        flushPendingRefresh(get);
        return !metadataFailureCurrent && !worktreeFailureCurrent;
      } catch (e) {
        const failureIsCurrent = () =>
          generation === null
            ? readRequestIsCurrent(get, worktreeRequests, worktreeOwner)
            : graphRequestIsCurrent(get, generation, summary.path);
        if (!failureIsCurrent()) {
          flushPendingRefresh(get);
          return false;
        }
        // A refresh failing because the repo's path vanished (deleted, or its
        // volume unmounted under an open tab) swaps in the missing-repo state
        // instead of the raw error (GL-108). Re-guard after the async probe —
        // a newer load may have replaced the displayed repo meanwhile.
        const missing = await wentMissing(summary.path, e);
        if (failureIsCurrent()) {
          if (missing) {
            const transitioned = await handleMissing(
              summary.path,
              missing,
              () => openIntent.isCurrent(entryIntent) && failureIsCurrent(),
            );
            if (!transitioned && failureIsCurrent()) {
              // A newer open intent can make the missing transition stand down
              // without superseding this read. Release only the loading flags
              // this request owned; the stale failure itself stays hidden.
              set({
                ...(opts?.quiet ? {} : { loading: false }),
                ...(generation !== null ? { graphLoading: false } : {}),
              });
            }
          } else if (failureIsCurrent()) {
            // When this refresh owns the graph request (generation !== null), clear
            // graphLoading too: it may have superseded the initial open, whose
            // orphaned load can't clear the skeleton itself (GL-20 review).
            // A quiet refresh never held `loading`, so it must not clear one.
            set({
              ...(opts?.quiet ? {} : { loading: false }),
              // A newer open intent wins before its phase-2 publication. Keep
              // this request's loading cleanup, but never describe its old
              // failure over the navigation the user just chose.
              ...(openIntent.isCurrent(entryIntent)
                ? { error: errorText(e) }
                : {}),
              ...(generation !== null ? { graphLoading: false } : {}),
            });
          }
        }
        flushPendingRefresh(get);
        return false;
      }
    },

    ...createRepoHistoryPaging(set, get),
  };
}