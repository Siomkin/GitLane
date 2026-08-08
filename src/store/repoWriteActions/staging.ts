// Index writes: staging and unstaging whole files, folder roll-ups, and single
// hunks/lines. Every one re-points the file selection after its refresh so the
// diff pane never renders a bucket the path just left.

import { api } from "@/lib/api";
import { fileWriteGuard, findGuardedFile } from "@/lib/advancedRepoState";
import type { RepoGet, RepoSet, RepoState } from "@/store/repoTypes";
import {
  captureFileSelection,
  captureOwner,
  fileSelectionIsCurrent,
  guardedPathMessage,
  ownerIsCurrent,
  refreshIfCurrent,
  renamePaths,
  toastAdvancedGuard,
  toastWriteError,
  withRenameCounterparts,
} from "./shared";

export function createStagingActions(
  set: RepoSet,
  get: RepoGet,
): Pick<
  RepoState,
  | "stageFile"
  | "unstageFile"
  | "stagePaths"
  | "unstagePaths"
  | "applyHunk"
  | "applyLine"
  | "stageAll"
  | "unstageAll"
> {
  return {
    stageFile: async (path) => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      const fileSelection = captureFileSelection(get);
      if (toastAdvancedGuard(guardedPathMessage(get, path))) return;
      try {
        // A worktree rename shows as one "R" entry naming the new path, but its
        // old path is still deleted in the index. Stage both together so the
        // index records a single rename instead of leaving the deletion behind
        // as a separate unstaged "D" (GL-127).
        const paths = renamePaths(get().changes.unstaged, path);
        if (paths) {
          await api.stageFiles(summary.path, paths);
        } else {
          await api.stageFile(summary.path, path);
        }
        if (
          await refreshIfCurrent(get, owner) &&
          fileSelectionIsCurrent(get, fileSelection)
        ) {
          await get().selectFile(path, "staged");
        }
      } catch (e) {
        toastWriteError(get, e, () => get().stageFile(path));
      }
    },

    unstageFile: async (path) => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      const fileSelection = captureFileSelection(get);
      if (toastAdvancedGuard(guardedPathMessage(get, path))) return;
      try {
        // Mirror of stageFile: restore both sides of a staged rename at once so
        // unstaging the new path doesn't leave the old path's deletion staged.
        const paths = renamePaths(get().changes.staged, path);
        if (paths) {
          await api.unstageFiles(summary.path, paths);
        } else {
          await api.unstageFile(summary.path, path);
        }
        if (
          await refreshIfCurrent(get, owner) &&
          fileSelectionIsCurrent(get, fileSelection)
        ) {
          await get().selectFile(path, "unstaged");
        }
      } catch (e) {
        toastWriteError(get, e, () => get().unstageFile(path));
      }
    },

    // Folder roll-up: stage/unstage a whole directory's files at once (one git
    // invocation, one refresh). Unlike the single-file actions these don't move
    // the selection — a folder action shouldn't hijack which file is being viewed.
    stagePaths: async (paths) => {
      const { summary } = get();
      if (!summary || paths.length === 0) return;
      const owner = captureOwner(summary);
      const blocked = paths.map((p) => guardedPathMessage(get, p)).find(Boolean) ?? null;
      if (toastAdvancedGuard(blocked)) return;
      try {
        // Pull each rolled-up rename's old side in too, so a rename under this
        // folder stages as one rename instead of a half-staged pair (GL-127).
        await api.stageFiles(summary.path, withRenameCounterparts(get().changes.unstaged, paths));
        await refreshIfCurrent(get, owner);
      } catch (e) {
        toastWriteError(get, e, () => get().stagePaths(paths));
      }
    },

    unstagePaths: async (paths) => {
      const { summary } = get();
      if (!summary || paths.length === 0) return;
      const owner = captureOwner(summary);
      const blocked = paths.map((p) => guardedPathMessage(get, p)).find(Boolean) ?? null;
      if (toastAdvancedGuard(blocked)) return;
      try {
        // Symmetric to stagePaths: unstage each rolled-up rename's old side too.
        await api.unstageFiles(summary.path, withRenameCounterparts(get().changes.staged, paths));
        await refreshIfCurrent(get, owner);
      } catch (e) {
        toastWriteError(get, e, () => get().unstagePaths(paths));
      }
    },

    applyHunk: async (path, staged, hunkIndex, expectedHeader, expectedBody) => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      const fileSelection = captureFileSelection(get);
      if (toastAdvancedGuard(guardedPathMessage(get, path))) return;
      try {
        await api.applyHunk(
          summary.path,
          path,
          staged,
          hunkIndex,
          expectedHeader,
          expectedBody,
        );
        const refreshed = await refreshIfCurrent(get, owner);
        if (!refreshed || !fileSelectionIsCurrent(get, fileSelection)) {
          return;
        }
        const { changes } = get();
        const preferred: "unstaged" | "staged" = staged ? "staged" : "unstaged";
        const fallback: "unstaged" | "staged" = staged ? "unstaged" : "staged";
        if (changes[preferred].some((file) => file.path === path)) {
          await get().selectFile(path, preferred);
        } else if (changes[fallback].some((file) => file.path === path)) {
          await get().selectFile(path, fallback);
        } else if (ownerIsCurrent(get, owner) && fileSelectionIsCurrent(get, fileSelection)) {
          set({ selectedFile: null, fileDiff: null });
        }
      } catch (e) {
        toastWriteError(get, e, () =>
          get().applyHunk(path, staged, hunkIndex, expectedHeader, expectedBody),
        );
      }
    },

    applyLine: async (path, staged, hunkIndex, lineIndex, line) => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      const fileSelection = captureFileSelection(get);
      if (toastAdvancedGuard(guardedPathMessage(get, path))) return;
      try {
        await api.applyLine(summary.path, path, staged, hunkIndex, lineIndex, line);
        const refreshed = await refreshIfCurrent(get, owner);
        if (!refreshed || !fileSelectionIsCurrent(get, fileSelection)) return;
        const { changes } = get();
        const preferred: "unstaged" | "staged" = staged ? "staged" : "unstaged";
        const fallback: "unstaged" | "staged" = staged ? "unstaged" : "staged";
        if (changes[preferred].some((file) => file.path === path)) {
          await get().selectFile(path, preferred);
        } else if (changes[fallback].some((file) => file.path === path)) {
          await get().selectFile(path, fallback);
        } else if (ownerIsCurrent(get, owner) && fileSelectionIsCurrent(get, fileSelection)) {
          set({ selectedFile: null, fileDiff: null });
        }
      } catch (e) {
        toastWriteError(get, e, () => get().applyLine(path, staged, hunkIndex, lineIndex, line));
      }
    },

    stageAll: async () => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      const { changes } = get();
      if (toastAdvancedGuard(fileWriteGuard(findGuardedFile(changes.unstaged, changes), changes))) return;
      try {
        await api.stageAll(summary.path);
        await refreshIfCurrent(get, owner);
      } catch (e) {
        toastWriteError(get, e, () => get().stageAll());
      }
    },

    unstageAll: async () => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      const { changes } = get();
      if (toastAdvancedGuard(fileWriteGuard(findGuardedFile(changes.staged, changes), changes))) return;
      try {
        await api.unstageAll(summary.path);
        await refreshIfCurrent(get, owner);
      } catch (e) {
        toastWriteError(get, e, () => get().unstageAll());
      }
    },
  };
}
