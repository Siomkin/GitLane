// The `scope: "worktree"` refresh — what a watcher event on the working tree
// alone needs re-read.
//
// Deliberately narrower than a full refresh: no graph, no branches, no remotes.
// It re-reads the working changes and the active operation, then follows every
// view that mirrors the tree (the working-tree comparison, a WIP-inclusive
// selection union, the open diff, the Files tab, the file viewer).

import { api, type OperationStatus } from "@/lib/api";
import { reconcileWorkingUnion } from "@/store/repoSelectionDiff";
import { reconcileFileDiff } from "@/store/repoFileDiff";
import { readRequestIsCurrent } from "@/store/repoGuards";
import { flushPendingRefresh } from "@/store/repoGuards";
import { worktreeRequests } from "@/store/repoRequests";
import type { RepoGet, RepoSet } from "@/store/repoTypes";
import { reconcileWorktreeState } from "@/store/repoWorktreeReconcile";
import { useUi } from "@/store/ui";
import { planSectionAvailability, resolveSectionRead, settleRead } from "./sectionFailures";

/** A secondary-read batch's ownership token. */
interface ReadOwner {
  path: string;
  session: number;
  generation: number;
}

export async function refreshWorktreeScope(
  set: RepoSet,
  get: RepoGet,
  path: string,
  opts: { quiet?: boolean } | undefined,
  worktreeOwner: ReadOwner,
): Promise<boolean> {
  const summary = { path };
  // The operation status rides along with working changes so a watcher
  // event (terminal commit/checkout/rebase step) keeps the conflict
  // workspace truthful. Best-effort: a failed read keeps the current
  // operation (see reconcileWorktreeState) and flags the section unavailable
  // instead of pretending no operation is underway.
  const [changes, opStatusRead] = await Promise.all([
    api.workingChanges(summary.path),
    settleRead(api.operationStatus(summary.path)),
  ]);
  if (!readRequestIsCurrent(get, worktreeRequests, worktreeOwner)) return false;
  const opRead = resolveSectionRead<OperationStatus | null>(opStatusRead, null);
  const availability = planSectionAvailability(get().unavailableSections, {
    operation: opRead.failure,
  });
  const worktreeReconciliation = reconcileWorktreeState({
    changes,
    opStatus: opRead.value,
    operation: get().operation,
    operationAdvisory: get().operationAdvisory,
    selectedFile: get().selectedFile,
    wipSelected: get().wipSelected,
  });
  set({
    ...worktreeReconciliation.patch,
    ...availability.patch,
    // Only clear the spinner if this call owned it (non-quiet). The quiet
    // watcher path never set it, so it must not clear a concurrent load's.
    ...(opts?.quiet ? {} : { loading: false }),
  });
  availability.notify();
  // The changes view has nothing to show over a clean tree — the ui
  // store falls back to the graph when it was the active view.
  if (worktreeReconciliation.noWip) useUi.getState().onWorkingTreeClean();
  // A working-tree comparison (head: null) reflects the live tree, so a
  // worktree-scope event (edit/stage/terminal commit) must refresh it.
  // Ref-to-ref comparisons are pinned to commits and don't change here.
  if (get().compare?.head === null) void get().refreshCompare();
  // Same for a merged selection that includes the WIP row — its diff
  // ends at the working tree, so an edit/stage must re-read it, and a
  // tree that just went clean must fold it back to committed-only.
  reconcileWorkingUnion(set, get, summary.path);
  // The changed-files list updated above, but the file open in the diff
  // viewer (`fileDiff`) is a separate slice `refresh` doesn't touch — so
  // an external edit to it would stay stale until re-click. Refetch it
  // quietly; skip when it was just cleared as gone (GL-123).
  if (!worktreeReconciliation.selectedFileGone) {
    void reconcileFileDiff(set, get, summary.path);
  }
  // The Files-tab listing mirrors the worktree; reload it (quietly, the
  // old list stays visible) once it has been loaded at least once.
  if (get().repoFiles) void get().loadRepoFiles();
  // An open file viewer follows the worktree too — re-read it so an
  // external edit is reflected (closes itself if the file vanished).
  if (get().fileView) void get().reloadFileView();
  if (!opts?.quiet) flushPendingRefresh(get);
  return true;
}
