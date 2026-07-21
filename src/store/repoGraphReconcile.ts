// Pure graph/selection reconciliation for a full repo refresh. Request/session
// ownership stays in repoRefreshActions; this module decides how a winning
// graph snapshot updates focus, multi-selection, and cached selection diffs.

import type { RepoGraph } from "@/lib/api";
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
  >
>;

export interface GraphSelectionReconciliation {
  patch: GraphSelectionPatch;
  publishSelection: boolean;
  selectedCommits: string[];
  selectionCommitToLoad: string | null;
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
  const multiNow = selectedCommits.length > 1;
  const sameSet =
    multiNow &&
    !!prevDiff &&
    prevDiff.commits.length === selectedCommits.length &&
    selectedCommits.every((id) => prevDiff.commits.includes(id));
  const reuseUnion = sameSet && !prevDiff!.error;
  const selectionDiff = !multiNow
    ? null
    : reuseUnion
      ? { ...prevDiff!, commits: selectedCommits }
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

  return {
    publishSelection,
    selectedCommits,
    selectionCommitToLoad,
    publishedSelectionRequestId,
    multiNow,
    reuseUnion,
    patch: publishSelection
      ? {
          ...(selectionChanged
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
        }
      : {},
  };
}
