// Working-tree file operations that aren't index writes: discarding, ignoring,
// untracking, restoring from a commit, and the OS hand-offs (reveal, open,
// difftool).

import { api } from "@/lib/api";
import { discardAllGuardMessage } from "@/lib/advancedRepoState";
import { useUi } from "@/store/ui";
import type { RepoGet, RepoState } from "@/store/repoTypes";
import {
  captureFileSelection,
  captureOwner,
  fileSelectionIsCurrent,
  guardedPathMessage,
  ownerIsCurrent,
  refreshIfCurrent,
  runOp,
  toastAdvancedGuard,
  toastWriteError,
} from "./shared";

export function createFileActions(
  get: RepoGet,
): Pick<
  RepoState,
  | "previewDiscardFile"
  | "discardFile"
  | "discardAll"
  | "appendIgnorePattern"
  | "revealInFileManager"
  | "openPathDefault"
  | "openPathDifftool"
  | "stopTracking"
  | "worktreeDiffersFromCommit"
  | "commitPathIsRestorable"
  | "restorePathFromCommit"
> {
  return {
    discardAll: (preview) => {
      const state = get();
      const guard = discardAllGuardMessage(state.changes, state.summary?.unborn === true);
      if (guard) return Promise.reject(new Error(guard));
      return runOp(
        get,
        async (summary) =>
          api.discardAll(
            summary.path,
            preview.expectedState,
            preview.expectedHeadBranch,
            preview.expectedHeadOid,
          ),
        // Untracked cleanup happens before the tracked reset. If that second
        // phase fails, the backend rejects after changing the worktree; refresh
        // on every guarded discard error so both partial failures and stale
        // preconditions leave the UI truthful while preserving the error text.
        // A stale lease is itself evidence that repository state drifted, so the
        // extra read is useful reconciliation rather than merely error cleanup.
        { refreshOnError: true },
      );
    },

    previewDiscardFile: (repoPath, path, previousPath, staged) => {
      if (get().summary?.path !== repoPath) {
        return Promise.reject(new Error("The active repository changed; preview the discard again."));
      }
      return api.previewDiscardFile(repoPath, path, previousPath, staged);
    },

    discardFile: async (repoPath, path, previousPath, staged, expectedState) => {
      const { summary } = get();
      if (!summary || summary.path !== repoPath) return;
      const owner = captureOwner(summary);
      const fileSelection = captureFileSelection(get);
      if (toastAdvancedGuard(guardedPathMessage(get, path))) return;
      try {
        await api.discardFile(
          repoPath,
          path,
          previousPath,
          staged,
          expectedState,
        );
        // The write belongs to the repo captured by the confirmation. If the
        // user switched tabs while it was in flight, its completion must not
        // refresh or reselect a same-named path in the newly active repo.
        if (!ownerIsCurrent(get, owner)) {
          return;
        }
        const refreshed = await refreshIfCurrent(get, owner);
        if (!refreshed || !ownerIsCurrent(get, owner)) {
          return;
        }
        // The discarded view is now empty. `refresh` drops the selection when the
        // path leaves both buckets; but a partially-staged file can survive in the
        // other bucket with a now-stale `source` — re-point the diff at it so the
        // pane never shows an empty diff for a file that still has changes.
        const { selectedFile, changes } = get();
        if (
          fileSelectionIsCurrent(get, fileSelection) &&
          selectedFile &&
          selectedFile.source !== "commit" &&
          selectedFile.path === path
        ) {
          if (changes.unstaged.some((f) => f.path === path)) await get().selectFile(path, "unstaged");
          else if (changes.staged.some((f) => f.path === path)) await get().selectFile(path, "staged");
        }
      } catch (e) {
        if (ownerIsCurrent(get, owner)) {
          toastWriteError(get, e, () =>
            get().discardFile(repoPath, path, previousPath, staged, expectedState),
          );
        }
      }
    },

    appendIgnorePattern: async (pattern, local = false) => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      try {
        await api.appendIgnorePattern(summary.path, pattern, local);
        if (!ownerIsCurrent(get, owner)) {
          return;
        }
        await refreshIfCurrent(get, owner);
      } catch (e) {
        if (ownerIsCurrent(get, owner)) {
          useUi.getState().showToast(String(e), "error");
        }
      }
    },

    revealInFileManager: async (path) => {
      const { summary } = get();
      if (!summary) return;
      try {
        await api.revealInFileManager(summary.path, path);
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    openPathDefault: async (path) => {
      const { summary } = get();
      if (!summary) return;
      try {
        await api.openPathDefault(summary.path, path);
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    openPathDifftool: async (path) => {
      const { summary } = get();
      if (!summary) return;
      try {
        await api.openPathDifftool(summary.path, path);
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
      }
    },

    stopTracking: async (path) => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      if (toastAdvancedGuard(guardedPathMessage(get, path))) return;
      try {
        await api.stopTracking(summary.path, path);
        if (!ownerIsCurrent(get, owner)) {
          return;
        }
        await refreshIfCurrent(get, owner);
      } catch (e) {
        if (ownerIsCurrent(get, owner)) {
          toastWriteError(get, e, () => get().stopTracking(path));
        }
      }
    },

    worktreeDiffersFromCommit: async (commitOid, path) => {
      const { summary } = get();
      if (!summary) throw new Error("No repository");
      return api.worktreeDiffersFromCommit(summary.path, commitOid, path);
    },

    commitPathIsRestorable: async (commitOid, path) => {
      const { summary } = get();
      if (!summary) return false;
      return api.commitPathIsRestorable(summary.path, commitOid, path);
    },

    restorePathFromCommit: async (commitOid, path) => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      try {
        await api.restorePathFromCommit(summary.path, commitOid, path);
        if (!ownerIsCurrent(get, owner)) {
          return;
        }
        await refreshIfCurrent(get, owner);
      } catch (e) {
        if (ownerIsCurrent(get, owner)) {
          toastWriteError(get, e, () => get().restorePathFromCommit(commitOid, path));
        }
      }
    },
  };
}
