// Pure working-tree refresh reconciliation. The refresh action owns request
// ordering and follow-up effects; this module only maps a fresh status snapshot
// plus the current selection/operation state into the store patch to publish.

import type { OperationStatus, WorkingChanges } from "@/lib/api";
import { mergeOperationStatus } from "./operation";
import type { OperationState, RepoState, SelectedFile } from "./repoTypes";

export interface WorktreeReconcileInput {
  changes: WorkingChanges;
  opStatus: OperationStatus | null;
  operation: OperationState | null;
  operationAdvisory: RepoState["operationAdvisory"];
  selectedFile: SelectedFile | null;
  wipSelected: boolean;
}

type WorktreeReconcilePatch = Pick<
  RepoState,
  "changes" | "operation" | "operationAdvisory"
> &
  Partial<Pick<RepoState, "selectedFile" | "fileDiff" | "wipSelected">>;

export interface WorktreeReconciliation {
  patch: WorktreeReconcilePatch;
  selectedFileGone: boolean;
  noWip: boolean;
}

export function reconcileWorktreeState({
  changes,
  opStatus,
  operation,
  operationAdvisory,
  selectedFile,
  wipSelected,
}: WorktreeReconcileInput): WorktreeReconciliation {
  const selectedFileGone = Boolean(
    selectedFile &&
      selectedFile.source !== "commit" &&
      !changes.staged.some((file) => file.path === selectedFile.path) &&
      !changes.unstaged.some((file) => file.path === selectedFile.path),
  );
  const noWip =
    changes.staged.length === 0 &&
    changes.unstaged.length === 0 &&
    changes.conflicted.length === 0;

  return {
    selectedFileGone,
    noWip,
    patch: {
      changes,
      // Fold in a fresh operation status; on a detection failure, only clear a
      // stale operation when no conflicts remain. A transient failure during
      // resolution must not yank the conflict workspace away.
      operation: opStatus
        ? mergeOperationStatus(operation, opStatus)
        : changes.conflicted.length === 0
          ? null
          : operation,
      // A failed status read leaves the prior advisory untouched to avoid a
      // transient banner flicker.
      operationAdvisory: opStatus ? opStatus.advisory || null : operationAdvisory,
      ...(selectedFileGone ? { selectedFile: null, fileDiff: null } : {}),
      ...(wipSelected && noWip ? { wipSelected: false } : {}),
    },
  };
}
