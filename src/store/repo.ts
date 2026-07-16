// Central app state. Keeps the open repo, its graph + branches, and the
// current selection. Async actions call the Rust layer via `api`.

import { create } from "zustand";
import { createRepoConflictActions } from "./repoConflictActions";
import { createRepoFilesActions } from "./repoFilesActions";
import { createRepoLifecycleActions } from "./repoLifecycleActions";
import { createRepoRefreshActions } from "./repoRefreshActions";
import { createRepoRemoteActions } from "./repoRemoteActions";
import { createRepoSelectionActions } from "./repoSelectionActions";
import { createRepoTabActions } from "./repoTabActions";
import {
  createInitialRepoData,
  initialSessionRestorePhase,
  type RepoState,
} from "./repoTypes";
import { readLastPath, readOpenPaths, readRecents, readTabInfo } from "./repoSession";
import { pruneTabInfo } from "@/lib/tabs";
import { createRepoWriteActions } from "./repoWriteActions";

export type {
  ActiveOperationKind,
  ChangeSource,
  MissingRepoState,
  OperationFile,
  OperationState,
  RepoState,
  SessionRestorePhase,
  SelectedFile,
} from "./repoTypes";
export { GRAPH_PAGE_SIZE, INITIAL_GRAPH_LIMIT, SESSION_RESTORE_PHASE } from "./repoTypes";

export const useRepo = create<RepoState>((set, get) => {
  const openPaths = readOpenPaths();
  const lastPath = readLastPath();

  return {
    // Tab info restores pruned to the restored tabs so closed paths never linger.
    ...createInitialRepoData(
      openPaths,
      readRecents(),
      pruneTabInfo(readTabInfo(), openPaths),
      initialSessionRestorePhase(openPaths, lastPath),
    ),
    ...createRepoLifecycleActions(set, get),
    ...createRepoTabActions(set, get),
    ...createRepoRefreshActions(set, get),
    ...createRepoSelectionActions(set, get),
    ...createRepoFilesActions(set, get),
    ...createRepoWriteActions(set, get),
    ...createRepoRemoteActions(set, get),
    ...createRepoConflictActions(set, get),
    clearError: () => set({ error: null }),
  };
});
