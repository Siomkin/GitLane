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
  OperationStatus,
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
import { planSectionAvailability, resolveSectionRead } from "./sectionFailures";

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
    /** The secondary section reads, settled: a rejection keeps the section's
     * last good value and flags it unavailable (sectionFailures.ts). */
    forge: PromiseSettledResult<RepoForge>;
    worktrees: PromiseSettledResult<WorktreeInfo[]>;
    stashes: PromiseSettledResult<StashEntry[]>;
    remotes: PromiseSettledResult<RemoteInfo[]>;
    opStatus: PromiseSettledResult<OperationStatus>;
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
// Each secondary section resolves to its fresh value, or its previous one on
// failure — never to an empty list/null that would read as "the repo has none".
const worktreesRead = resolveSectionRead(worktrees, get().worktrees);
const stashesRead = resolveSectionRead(stashes, get().stashes);
const forgeRead = resolveSectionRead<RepoForge | null>(forge, get().forge);
const remotesRead = resolveSectionRead(remotes, get().remotes);
// A rejected status read resolves to null, which the reconciler already reads
// as "detection failed": it keeps the operation while conflicts remain and
// leaves the advisory alone; the `operation` flag adds the explicit banner.
const opRead = resolveSectionRead<OperationStatus | null>(opStatus, null);
const worktreeReconciliation = reconcileWorktreeState({
  changes,
  opStatus: opRead.value,
  operation: get().operation,
  operationAdvisory: get().operationAdvisory,
  selectedFile: get().selectedFile,
  wipSelected: get().wipSelected,
});
// Only the lanes this refresh still owns report their outcomes: a superseded
// request must neither flag nor clear a section.
const availability = planSectionAvailability(get().unavailableSections, {
  ...(metadataCurrent
    ? { worktrees: worktreesRead.failure, stashes: stashesRead.failure, forge: forgeRead.failure }
    : {}),
  ...(remotesCurrent ? { remotes: remotesRead.failure } : {}),
  ...(worktreeCurrent ? { operation: opRead.failure } : {}),
});
const secondaryPatch = {
  ...(metadataCurrent
    ? {
        forge: forgeRead.value,
        branches,
        worktrees: worktreesRead.value,
        stashes: stashesRead.value,
      }
    : {}),
  ...(remotesCurrent ? { remotes: remotesRead.value } : {}),
  ...(worktreeCurrent ? worktreeReconciliation.patch : {}),
  ...availability.patch,
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
  // The section flags landed with `secondaryPatch`; announce the transitions.
  availability.notify();
  if (
    branchesResult.status === "fulfilled" &&
    metadataOwner !== null &&
    readRequestIsCurrent(get, metadataRequests, metadataOwner)
  ) {
    markMetadataReadyForPr(session, metadataOwner.generation, forgeRead.value !== null);
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
