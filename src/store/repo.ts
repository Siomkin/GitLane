// Central app state. Keeps the open repo, its graph + branches, and the
// current selection. Async actions call the Rust layer via `api`.

import { create } from "zustand";
import { createRepoLifecycleActions } from "./repoLifecycleActions";
import { createRepoSelectionActions } from "./repoSelectionActions";
import { createInitialRepoData, type RepoState } from "./repoTypes";
import { readOpenPaths } from "./repoSession";
import { createRepoWriteActions } from "./repoWriteActions";

export type { ChangeSource, RepoState, SelectedFile } from "./repoTypes";
export { GRAPH_PAGE_SIZE, INITIAL_GRAPH_LIMIT } from "./repoTypes";

export const useRepo = create<RepoState>((set, get) => ({
  ...createInitialRepoData(readOpenPaths()),
  ...createRepoLifecycleActions(set, get),
  ...createRepoSelectionActions(set, get),
  ...createRepoWriteActions(set, get),
  clearError: () => set({ error: null }),
}));
