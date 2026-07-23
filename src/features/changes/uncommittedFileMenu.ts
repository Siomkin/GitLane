import type { FileChange } from "@/lib/api";

/** ADR 0002 / GL-337: which deferred working-tree verbs a row may offer.
 * Stage/Unstage stay inline-only; rename undo stays deferred. */
export interface UncommittedFileMenuActions {
  /** Pathspec stash for this one file (tracked or untracked). */
  stashFile: boolean;
  /** `git rm --cached` — tracked paths only; keeps the worktree leaf. */
  stopTracking: boolean;
  /** Write a `.patch` for this path's working-tree delta. */
  createPatch: boolean;
  /** Open the on-disk leaf with the OS default app (missing/deleted → hide). */
  openDefaultApp: boolean;
  /** `git difftool` against HEAD for this path (needs a tracked delta). */
  openDiffTool: boolean;
}

/** Decide which GL-337 deferred verbs apply to a working-tree row. */
export function uncommittedFileMenuActions(
  entry: FileChange | undefined,
): UncommittedFileMenuActions {
  if (!entry) {
    return {
      stashFile: false,
      stopTracking: false,
      createPatch: false,
      openDefaultApp: false,
      openDiffTool: false,
    };
  }
  const untracked = entry.status === "U";
  const renamed = entry.status === "R";
  const deleted = entry.status === "D";
  const submodule = entry.advanced?.kind === "submodule";
  // Submodules are not ordinary pathspec targets for these verbs.
  if (submodule) {
    return {
      stashFile: false,
      stopTracking: false,
      createPatch: false,
      openDefaultApp: false,
      openDiffTool: false,
    };
  }
  return {
    stashFile: !renamed,
    stopTracking: !untracked && !renamed && !deleted,
    createPatch: !renamed,
    openDefaultApp: !deleted,
    openDiffTool: !untracked && !renamed,
  };
}
