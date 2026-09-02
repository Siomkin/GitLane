// Pure graph/selection reconciliation for a full repo refresh. Request/session
// ownership stays in repoRefreshActions; this module decides how a winning
// graph snapshot updates focus, multi-selection, and cached selection diffs.

import type { RepoGraph } from "@/lib/api";
import { workingRange } from "./selection";
import type { RepoState, SelectedFile, SelectionDiffState } from "./repoTypes";

export interface RefreshSelectionOwner {
  requestId: number;
  selectedCommit: string | null;
  selectedCommits: string[];
}

export interface LiveRefreshSelection extends RefreshSelectionOwner {
  selectionAnchor: string | null;
  selectionDiff: SelectionDiffState | null;
  selectedFile: SelectedFile | null;
  /** The uncommitted row is part of the selection — its merged diff ends at the
   * working tree, so it stays merged even with a single commit picked. */
  wipSelected?: boolean;
}

type GraphSelectionPatch = Partial<
  Pick<
    RepoState,
    | "fileSelectionRequestId"
    | "commitFiles"
    | "diffLoading"
    | "selectedFile"
    | "fileDiff"
    | "selectedCommit"
    | "selectedCommits"
    | "selectionAnchor"
    | "selectionDiff"
    | "wipSelected"
    | "inspectParentIndex"
  >
>;

export interface GraphSelectionReconciliation {
  patch: GraphSelectionPatch;
  publishSelection: boolean;
  selectedCommits: string[];
  selectionCommitToLoad: string | null;
  /** Base of the working-tree-ended union to reload, or null for a plain one. */
  workingBase: string | null;
  publishedSelectionRequestId: number;
  multiNow: boolean;
  reuseUnion: boolean;
}

export function reconcileGraphSelection({
  graph,
  selectionOwner,
  liveSelection,
  repoSessionCurrent,
}: {
  graph: RepoGraph;
  selectionOwner: RefreshSelectionOwner;
  liveSelection: LiveRefreshSelection;
  repoSessionCurrent: boolean;
}): GraphSelectionReconciliation {
  // Trim the multi-selection to ids that still exist after the refresh — e.g.
  // a reset/rebase can drop selected commits. Anchor stays if it survives;
  // otherwise it tracks the new focus commit.
  const liveIds = new Set(graph.commits.map((commit) => commit.id));
  const selectionOwnerCurrent =
    repoSessionCurrent &&
    liveSelection.requestId === selectionOwner.requestId &&
    liveSelection.selectedCommit === selectionOwner.selectedCommit &&
    liveSelection.selectedCommits === selectionOwner.selectedCommits;
  const liveFocusSurvives =
    liveSelection.selectedCommit !== null && liveIds.has(liveSelection.selectedCommit);
  const liveSelectionSetSurvives = liveSelection.selectedCommits.every((id) => liveIds.has(id));

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

  // Preserve reference identity when the selected commit set did not change.
  // Batch writes use the array as their owner token, so a deliberate A -> B ->
  // A cycle (new array, same values) must not look untouched.
  const selectedCommits =
    previousSelectedCommits.length === nextSelectedCommits.length &&
    previousSelectedCommits.every((id) => nextSelectedCommits.includes(id))
      ? previousSelectedCommits
      : nextSelectedCommits;
  const selectionAnchor =
    liveSelection.selectionAnchor && liveIds.has(liveSelection.selectionAnchor)
      ? liveSelection.selectionAnchor
      : selectedCommit;

  // Reconcile the merged-selection union with the possibly trimmed selection.
  // A healthy unchanged set keeps immutable-by-oid files; a changed/error set
  // reloads, and a collapse to one commit drops the union.
  const prevDiff = liveSelection.selectionDiff;
  // Re-derive the working-tree range from the *new* graph rather than trusting
  // the cached base: HEAD moves under us (a terminal commit, an amend, a
  // checkout), and a base kept from the old graph would quietly diff commits
  // that are no longer part of the pick.
  const workingBase =
    liveSelection.wipSelected && prevDiff?.workingBase && liveSelectionSetSurvives
      ? workingRange(graph, selectedCommits)?.base ?? null
      : null;
  // The WIP row can't stay lit once its range is gone — that state routes and
  // reads as "commits + uncommitted" with nothing behind it.
  const wipLost = !!prevDiff?.workingBase && workingBase === null;
  const multiNow = selectedCommits.length > 1 || workingBase !== null;
  const sameSet =
    multiNow &&
    !!prevDiff &&
    prevDiff.commits.length === selectedCommits.length &&
    selectedCommits.every((id) => prevDiff.commits.includes(id));
  // Never reuse a cached working-tree union: its content is the live worktree,
  // which is exactly what changed to trigger this refresh. That covers both
  // directions — a union that *had* a base can't be reused either, or dropping
  // WIP would keep its worktree-era files (and its base) under a committed set.
  const reuseUnion =
    sameSet && !prevDiff!.error && workingBase === null && !prevDiff!.workingBase;
  const selectionDiff = !multiNow
    ? null
    : reuseUnion
      ? { ...prevDiff!, commits: selectedCommits }
      : { commits: selectedCommits, files: [], workingBase, loading: true, error: null };
  const fellBackSelection = liveSelection.selectedCommit !== selectedCommit;
  const selectionSetChanged = selectedCommits !== previousSelectedCommits;
  const selectionChanged = fellBackSelection || selectionSetChanged;
  // Losing WIP with one commit still picked drops the union without changing the
  // selection, so the inspector would fall back to the single-commit view with
  // no file list. Treat it as a route change: reload that commit's own files.
  const unionCollapsed = !!prevDiff?.workingBase && !multiNow;
  // A base that changed under a surviving selection is a different diff too, so
  // the open file (fetched from the old range) must not be kept.
  const baseChanged = (prevDiff?.workingBase ?? null) !== workingBase;
  const routeChanged = selectionChanged || unionCollapsed || baseChanged;
  const publishedSelectionRequestId = routeChanged
    ? liveSelection.requestId + 1
    : liveSelection.requestId;
  const selectionCommitToLoad =
    !preserveNewerSelection && routeChanged && selectedCommits.length <= 1
      ? selectedCommit
      : null;
  const publishSelection = !preserveNewerSelection;

  return {
    publishSelection,
    selectedCommits,
    selectionCommitToLoad,
    publishedSelectionRequestId,
    multiNow,
    reuseUnion,
    workingBase,
    patch: publishSelection
      ? {
          ...(routeChanged
            ? {
                fileSelectionRequestId: publishedSelectionRequestId,
                commitFiles: [],
                diffLoading: selectionCommitToLoad !== null,
                ...(liveSelection.selectedFile?.source === "commit"
                  ? { selectedFile: null, fileDiff: null }
                  : {}),
              }
            : {}),
          selectedCommit,
          selectedCommits,
          selectionAnchor,
          selectionDiff,
          ...(wipLost ? { wipSelected: false } : {}),
          ...(fellBackSelection ? { inspectParentIndex: 0 } : {}),
        }
      : {},
  };
}
