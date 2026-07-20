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
  metadataRequestIsCurrent,
  reflogRequestIsCurrent,
  remotesRequestIsCurrent,
  repoSessionIsCurrent,
  worktreeRequestIsCurrent,
} from "./repoGuards";
import { createMissingRepoHandlers, errorText } from "./repoMissing";
import {
  beginGraphRequest,
  beginMetadataRequest,
  beginReflogRequest,
  beginRemotesRequest,
  beginWorktreeRequest,
  claimPrPrefetch,
  currentPublishedRepoSession,
  currentOpenIntent,
  deferRefresh,
  markMetadataReadyForPr,
  markRemotesReadyForPr,
  openIntentIsCurrent,
  requestPrPrefetch,
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
      const session = currentPublishedRepoSession();
      const worktreeOwner = {
        path: summary.path,
        session,
        generation: beginWorktreeRequest(),
      };
      const generation = opts?.scope === "worktree" ? null : beginGraphRequest();
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
          // The operation status rides along with working changes so a watcher
          // event (terminal commit/checkout/rebase step) keeps the conflict
          // workspace truthful. Best-effort — degrade to "no operation".
          const [changes, opStatus] = await Promise.all([
            api.workingChanges(summary.path),
            api.operationStatus(summary.path).catch(() => null),
          ]);
          if (!worktreeRequestIsCurrent(get, worktreeOwner)) return false;
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
          if (!opts?.quiet) flushPendingRefresh(get);
          return true;
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
        let ownsMetadataFailure = false;
        let ownedMetadataFailure: unknown;
        if (
          branchesResult.status === "rejected" &&
          metadataOwner !== null &&
          metadataRequestIsCurrent(get, metadataOwner)
        ) {
          const missing = await wentMissing(summary.path, branchesResult.reason);
          if (metadataRequestIsCurrent(get, metadataOwner)) {
            if (missing) {
              const transitioned = await handleMissing(
                summary.path,
                missing,
                () =>
                  openIntentIsCurrent(entryIntent) &&
                  metadataRequestIsCurrent(get, metadataOwner),
              );
              if (transitioned) {
                flushPendingRefresh(get);
                return false;
              }
            }
            if (metadataRequestIsCurrent(get, metadataOwner)) {
              ownsMetadataFailure = true;
              ownedMetadataFailure = branchesResult.reason;
            }
          }
        }
        // Keep the required working-changes rejection settled until every
        // independent lane has completed. If a newer worktree request already
        // superseded it, this refresh may still publish its graph, metadata and
        // remotes instead of losing them to Promise.all rejection.
        let ownsWorktreeFailure = false;
        let ownedWorktreeFailure: unknown;
        if (
          changesResult.status === "rejected" &&
          worktreeRequestIsCurrent(get, worktreeOwner)
        ) {
          const missing = await wentMissing(summary.path, changesResult.reason);
          if (worktreeRequestIsCurrent(get, worktreeOwner)) {
            if (missing) {
              const transitioned = await handleMissing(
                summary.path,
                missing,
                () =>
                  openIntentIsCurrent(entryIntent) &&
                  worktreeRequestIsCurrent(get, worktreeOwner),
              );
              if (transitioned) {
                flushPendingRefresh(get);
                return false;
              }
              // A newer worktree request can claim its lane while the removed-
              // worktree fallback probes a parent path. If that made the
              // handler stand down, resume this refresh's still-current graph,
              // metadata and remotes publication, omitting the lost lane.
            }
            // If the lane is still ours, retain the failure so the graph shell
            // can finish and clear its loading state; a newer open intent only
            // suppresses the old error text. If a newer worktree request won
            // during the probe, omit this lane and continue the other owners.
            if (worktreeRequestIsCurrent(get, worktreeOwner)) {
              ownsWorktreeFailure = true;
              ownedWorktreeFailure = changesResult.reason;
            }
          }
        }
        const changes =
          changesResult.status === "fulfilled" ? changesResult.value : get().changes;
        const branches =
          branchesResult.status === "fulfilled" ? branchesResult.value : get().branches;
        let ownsGraphFailure = false;
        let ownedGraphFailure: unknown;
        if (
          graphResult.status === "rejected" &&
          generation !== null &&
          graphRequestIsCurrent(get, generation, summary.path)
        ) {
          const missing = await wentMissing(summary.path, graphResult.reason);
          if (graphRequestIsCurrent(get, generation, summary.path)) {
            if (missing) {
              const transitioned = await handleMissing(
                summary.path,
                missing,
                () =>
                  openIntentIsCurrent(entryIntent) &&
                  graphRequestIsCurrent(get, generation, summary.path),
              );
              if (transitioned) {
                flushPendingRefresh(get);
                return false;
              }
            }
            if (graphRequestIsCurrent(get, generation, summary.path)) {
              ownsGraphFailure = true;
              ownedGraphFailure = graphResult.reason;
            }
          }
        }

        const graphCurrent =
          generation !== null && graphRequestIsCurrent(get, generation, summary.path);
        const metadataCurrent =
          branchesResult.status === "fulfilled" &&
          metadataOwner !== null &&
          metadataRequestIsCurrent(get, metadataOwner);
        const worktreeCurrent =
          changesResult.status === "fulfilled" &&
          worktreeRequestIsCurrent(get, worktreeOwner);
        const remotesCurrent =
          remotesOwner !== null && remotesRequestIsCurrent(get, remotesOwner);
        const selectedWorkingFile = get().selectedFile;
        const selectedFileGone =
          selectedWorkingFile &&
          selectedWorkingFile.source !== "commit" &&
          !changes.staged.some((file) => file.path === selectedWorkingFile.path) &&
          !changes.unstaged.some((file) => file.path === selectedWorkingFile.path);
        const noWip =
          changes.staged.length === 0 &&
          changes.unstaged.length === 0 &&
          changes.conflicted.length === 0;
        const secondaryPatch = {
          ...(metadataCurrent ? { forge, branches, worktrees, stashes } : {}),
          ...(remotesCurrent ? { remotes } : {}),
          ...(worktreeCurrent
            ? {
                changes,
                operation: opStatus
                  ? mergeOperationStatus(get().operation, opStatus)
                  : changes.conflicted.length === 0
                    ? null
                    : get().operation,
                operationAdvisory: opStatus
                  ? opStatus.advisory || null
                  : get().operationAdvisory,
                ...(selectedFileGone ? { selectedFile: null, fileDiff: null } : {}),
                ...(get().wipSelected && noWip ? { wipSelected: false } : {}),
              }
            : {}),
        };
        const metadataFailureCurrent =
          ownsMetadataFailure &&
          metadataOwner !== null &&
          metadataRequestIsCurrent(get, metadataOwner);
        const worktreeFailureCurrent =
          ownsWorktreeFailure && worktreeRequestIsCurrent(get, worktreeOwner);
        const graphFailureCurrent = ownsGraphFailure && graphCurrent;
        const hasOwnedFailure =
          graphFailureCurrent || metadataFailureCurrent || worktreeFailureCurrent;
        const ownedFailure = graphFailureCurrent
          ? ownedGraphFailure
          : metadataFailureCurrent
            ? ownedMetadataFailure
            : worktreeFailureCurrent
              ? ownedWorktreeFailure
              : null;
        const publishSecondaryEffects = () => {
          if (
            branchesResult.status === "fulfilled" &&
            metadataOwner !== null &&
            metadataRequestIsCurrent(get, metadataOwner)
          ) {
            markMetadataReadyForPr(session, metadataOwner.generation, forge !== null);
          }
          if (remotesOwner !== null && remotesRequestIsCurrent(get, remotesOwner)) {
            useAccounts.getState().syncRepoAccount(summary.path);
            markRemotesReadyForPr(session, remotesOwner.generation);
          }
          if (
            changesResult.status === "fulfilled" &&
            worktreeRequestIsCurrent(get, worktreeOwner)
          ) {
            if (noWip) useUi.getState().onWorkingTreeClean();
            if (!selectedFileGone) void reconcileFileDiff(set, get, summary.path);
            if (get().compare?.head === null) void get().refreshCompare();
            if (get().repoFiles) void get().loadRepoFiles();
            if (get().fileView) void get().reloadFileView();
          }
          if (claimPrPrefetch(session)) {
            void usePulls.getState().loadPullRequests(false, true);
          }
        };

        if (graphResult.status !== "fulfilled" || !graphCurrent) {
          set({
            ...secondaryPatch,
            ...(graphFailureCurrent
              ? {
                  ...(opts?.quiet ? {} : { loading: false }),
                  graphLoading: false,
                }
              : {}),
            ...(hasOwnedFailure && openIntentIsCurrent(entryIntent)
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
        // Trim the multi-selection to ids that still exist after the refresh —
        // e.g. a reset/rebase can drop the selected commits. Anchor stays if it
        // survives; otherwise it tracks the new focus commit.
        const liveIds = new Set(graph.commits.map((c) => c.id));
        const liveSelection = {
          requestId: get().fileSelectionRequestId,
          selectedCommit: get().selectedCommit,
          selectedCommits: get().selectedCommits,
        };
        const selectionOwnerCurrent =
          repoSessionIsCurrent(get, summary.path, session) &&
          liveSelection.requestId === selectionOwner.requestId &&
          liveSelection.selectedCommit === selectionOwner.selectedCommit &&
          liveSelection.selectedCommits === selectionOwner.selectedCommits;
        const liveFocusSurvives =
          liveSelection.selectedCommit !== null && liveIds.has(liveSelection.selectedCommit);
        const liveSelectionSetSurvives = liveSelection.selectedCommits.every((id) =>
          liveIds.has(id),
        );
        // A newer foreground selection that is valid in the authoritative graph
        // owns its focus/files wholesale. An invalid/removed focus must still be
        // reconciled to the graph tip so the inspector cannot point outside it.
        const preserveNewerSelection =
          !selectionOwnerCurrent && liveFocusSurvives && liveSelectionSetSurvives;
        const selectedCommit = liveFocusSurvives
          ? liveSelection.selectedCommit
          : graph.commits.find((commit) => !commit.stash)?.id ?? null;
        const previousSelectedCommits = liveSelection.selectedCommits;
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
        const fellBackSelection = liveSelection.selectedCommit !== selectedCommit;
        const selectionSetChanged = selectedCommits !== previousSelectedCommits;
        const selectionChanged = fellBackSelection || selectionSetChanged;
        const publishedSelectionRequestId = selectionChanged
          ? liveSelection.requestId + 1
          : liveSelection.requestId;
        const selectionCommitToLoad =
          !preserveNewerSelection && selectionChanged && selectedCommits.length <= 1
            ? selectedCommit
            : null;
        const publishSelection = !preserveNewerSelection;
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
          ...(publishSelection
            ? {
                ...(selectionChanged
                  ? {
                      fileSelectionRequestId: publishedSelectionRequestId,
                      commitFiles: [],
                      diffLoading: selectionCommitToLoad !== null,
                      ...(get().selectedFile?.source === "commit"
                        ? { selectedFile: null, fileDiff: null }
                        : {}),
                    }
                  : {}),
                selectedCommit,
                selectedCommits,
                selectionAnchor,
                selectionDiff,
              }
            : {}),
          ...(opts?.quiet ? {} : { loading: false }),
          // A refresh can supersede the initial open's graph request (e.g. a
          // checkout from the navigator while the skeleton is still up). When it
          // does, that orphaned load returns without clearing graphLoading, so
          // this owning refresh must clear it or the skeleton sticks (GL-20 review).
          graphLoading: false,
          ...(hasOwnedFailure && openIntentIsCurrent(entryIntent)
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
        if (publishSelection && multiNow && !reuseUnion) {
          void loadSelectionUnion(set, get, nextSummary.path, selectedCommits);
        }
        if (selectionCommitToLoad) {
          const fallbackIsCurrent = () =>
            repoSessionIsCurrent(get, nextSummary.path, session) &&
            get().fileSelectionRequestId === publishedSelectionRequestId &&
            get().selectedCommit === selectionCommitToLoad;
          void api
            .commitFiles(nextSummary.path, selectionCommitToLoad)
            .then((files) => {
              if (fallbackIsCurrent()) set({ commitFiles: files, diffLoading: false });
            })
            .catch(async (error) => {
              if (!fallbackIsCurrent()) return;
              await surfaceOpenFailure(
                nextSummary.path,
                error,
                () => openIntentIsCurrent(entryIntent) && fallbackIsCurrent(),
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
            ? worktreeRequestIsCurrent(get, worktreeOwner)
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
              () => openIntentIsCurrent(entryIntent) && failureIsCurrent(),
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
              ...(openIntentIsCurrent(entryIntent)
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
      const owner = {
        path: summary.path,
        session: currentPublishedRepoSession(),
        generation: beginReflogRequest(),
      };
      set({ reflogLoading: true, reflogError: null });
      try {
        const reflogEntries = await api.listReflog(summary.path, 120);
        if (!reflogRequestIsCurrent(get, owner)) return;
        set({ reflogEntries, reflogLoading: false });
      } catch (e) {
        if (!reflogRequestIsCurrent(get, owner)) return;
        set({ reflogLoading: false, reflogError: String(e) });
      }
    },
  };
}
