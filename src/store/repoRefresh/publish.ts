// Deciding what a completed full refresh may publish.
//
// Each lane (graph, required metadata, working changes, remotes) is re-checked
// for ownership *after* every await, because a newer request can claim one while
// this refresh was in flight. Only the lanes still owned contribute to the
// patch; only their failures contribute to the error, in a fixed precedence
// (graph, then metadata, then worktree) so two rejections in one refresh always
// surface the same message.

import type {
  BranchInfo,
  RemoteInfo,
  RepoForge,
  StashEntry,
  WorkingChanges,
  WorktreeInfo,
} from "@/lib/api";
import { useAccounts } from "@/store/accounts";
import { usePulls } from "@/store/pulls";
import { readRequestIsCurrent, graphRequestIsCurrent } from "@/store/repoGuards";
import { reconcileFileDiff } from "@/store/repoFileDiff";
import {
  claimPrPrefetch,
  markMetadataReadyForPr,
  markRemotesReadyForPr,
  metadataRequests,
  remotesRequests,
  worktreeRequests,
} from "@/store/repoRequests";
import type { RepoGet, RepoSet } from "@/store/repoTypes";
import { reconcileWorktreeState } from "@/store/repoWorktreeReconcile";
import { useUi } from "@/store/ui";
import type { ClaimedLane } from "./laneFailures";

interface ReadOwner {
  path: string;
  session: number;
  generation: number;
}

export interface RefreshPublication {
  graphCurrent: boolean;
  /** The worktree lane's reconciliation — the graph publication reads its
   * `noWip` so a tree that just went clean folds the WIP row in the same set. */
  worktreeReconciliation: ReturnType<typeof reconcileWorktreeState>;
  metadataCurrent: boolean;
  worktreeCurrent: boolean;
  remotesCurrent: boolean;
  secondaryPatch: Record<string, unknown>;
  metadataFailureCurrent: boolean;
  worktreeFailureCurrent: boolean;
  graphFailureCurrent: boolean;
  hasOwnedFailure: boolean;
  ownedFailure: unknown;
  /** Side effects that must run whether or not the graph landed: PR readiness,
   * account re-resolution, and the views that follow the working tree. */
  publishSecondaryEffects: () => void;
}

export function planRefreshPublication(
  set: RepoSet,
  get: RepoGet,
  summary: { path: string },
  opts: {
    generation: number | null;
    session: number;
    entryIntent: number;
    metadataOwner: ReadOwner | null;
    worktreeOwner: ReadOwner;
    remotesOwner: ReadOwner | null;
    branchesResult: PromiseSettledResult<BranchInfo[]>;
    changesResult: PromiseSettledResult<WorkingChanges>;
    changes: WorkingChanges;
    branches: BranchInfo[];
    forge: RepoForge | null;
    worktrees: WorktreeInfo[];
    stashes: StashEntry[];
    remotes: RemoteInfo[];
    opStatus: Parameters<typeof reconcileWorktreeState>[0]["opStatus"];
    metadataFailure: ClaimedLane;
    worktreeFailure: ClaimedLane;
    graphFailure: ClaimedLane;
  },
): RefreshPublication {
  const {
    generation,
    session,
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
  } = opts;
const graphCurrent =
  generation !== null && graphRequestIsCurrent(get, generation, summary.path);
const metadataCurrent =
  branchesResult.status === "fulfilled" &&
  metadataOwner !== null &&
  readRequestIsCurrent(get, metadataRequests, metadataOwner);
const worktreeCurrent =
  changesResult.status === "fulfilled" &&
  readRequestIsCurrent(get, worktreeRequests, worktreeOwner);
const remotesCurrent =
  remotesOwner !== null && readRequestIsCurrent(get, remotesRequests, remotesOwner);
const worktreeReconciliation = reconcileWorktreeState({
  changes,
  opStatus,
  operation: get().operation,
  operationAdvisory: get().operationAdvisory,
  selectedFile: get().selectedFile,
  wipSelected: get().wipSelected,
});
const secondaryPatch = {
  ...(metadataCurrent ? { forge, branches, worktrees, stashes } : {}),
  ...(remotesCurrent ? { remotes } : {}),
  ...(worktreeCurrent ? worktreeReconciliation.patch : {}),
};
const metadataFailureCurrent =
  metadataFailure.owns &&
  metadataOwner !== null &&
  readRequestIsCurrent(get, metadataRequests, metadataOwner);
const worktreeFailureCurrent =
  worktreeFailure.owns && readRequestIsCurrent(get, worktreeRequests, worktreeOwner);
const graphFailureCurrent = graphFailure.owns && graphCurrent;
const hasOwnedFailure =
  graphFailureCurrent || metadataFailureCurrent || worktreeFailureCurrent;
const ownedFailure = graphFailureCurrent
  ? (graphFailure as { error: unknown }).error
  : metadataFailureCurrent
    ? (metadataFailure as { error: unknown }).error
    : worktreeFailureCurrent
      ? (worktreeFailure as { error: unknown }).error
      : null;
const publishSecondaryEffects = () => {
  if (
    branchesResult.status === "fulfilled" &&
    metadataOwner !== null &&
    readRequestIsCurrent(get, metadataRequests, metadataOwner)
  ) {
    markMetadataReadyForPr(session, metadataOwner.generation, forge !== null);
  }
  if (remotesOwner !== null && readRequestIsCurrent(get, remotesRequests, remotesOwner)) {
    useAccounts.getState().syncRepoAccount(summary.path);
    markRemotesReadyForPr(session, remotesOwner.generation);
  }
  if (
    changesResult.status === "fulfilled" &&
    readRequestIsCurrent(get, worktreeRequests, worktreeOwner)
  ) {
    if (worktreeReconciliation.noWip) useUi.getState().onWorkingTreeClean();
    if (!worktreeReconciliation.selectedFileGone) {
      void reconcileFileDiff(set, get, summary.path);
    }
    if (get().compare?.head === null) void get().refreshCompare();
    if (get().repoFiles) void get().loadRepoFiles();
    if (get().fileView) void get().reloadFileView();
  }
  if (claimPrPrefetch(session)) {
    void usePulls.getState().loadPullRequests(false, true);
  }
};
  return {
    graphCurrent,
    worktreeReconciliation,
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
  };
}
