// Index writes and the per-path working-tree operations beside them: stage and
// unstage whole files, folder roll-ups, hunks and lines, discard, ignore,
// untrack, and restore-from-commit. Mirrors `commands/staging.rs`.

import { invoke } from "@/lib/api/invoke";
import type {
  DiffLine,
  DiscardFilePreview,
} from "./types";

export const stagingApi = {
  previewDiscardFile: (
    path: string,
    file: string,
    previousFile: string | null,
    staged: boolean,
  ) =>
    invoke<DiscardFilePreview>("preview_discard_file", {
      path,
      file,
      previousFile,
      staged,
    }),

  stageFile: (path: string, file: string) =>
    invoke<string>("stage_file", { path, file }),

  unstageFile: (path: string, file: string) =>
    invoke<string>("unstage_file", { path, file }),

  /** Stage one hunk from an unstaged diff, or unstage one hunk from a staged diff.
   * `expectedBody` is the displayed hunk's canonical body; the backend rejects the
   * stage if the current patch's hunk content no longer matches it. */
  applyHunk: (
    path: string,
    file: string,
    staged: boolean,
    hunkIndex: number,
    expectedHeader: string,
    expectedBody: string,
  ) => invoke<string>("apply_hunk", { path, file, staged, hunkIndex, expectedHeader, expectedBody }),

  /** Stage one changed line from an unstaged diff, or unstage one changed line from a staged diff. */
  applyLine: (
    path: string,
    file: string,
    staged: boolean,
    hunkIndex: number,
    lineIndex: number,
    line: DiffLine,
  ) =>
    invoke<string>("apply_line", {
      path,
      file,
      staged,
      hunkIndex,
      lineIndex,
      expectedKind: line.kind,
      expectedContent: line.content,
      expectedOldNo: line.oldNo,
      expectedNewNo: line.newNo,
    }),

  /** Stage several files atomically (one `git add -A`). */
  stageFiles: (path: string, files: string[]) =>
    invoke<string>("stage_files", { path, files }),

  /** Unstage several files atomically (one `git restore --staged`). */
  unstageFiles: (path: string, files: string[]) =>
    invoke<string>("unstage_files", { path, files }),

  /** Discard one exact previewed file state. Staged changes restore from HEAD;
   * unstaged changes restore from the index. Renames carry `previousFile` so
   * both sides are handled as one logical change. */
  discardFile: (
    path: string,
    file: string,
    previousFile: string | null,
    staged: boolean,
    expectedState: string,
  ) => invoke<string>("discard_file", { path, file, previousFile, staged, expectedState }),

  /** Append one gitignore pattern to root `.gitignore`, or to `.git/info/exclude`
   * when `local` is true. */
  appendIgnorePattern: (path: string, pattern: string, local: boolean) =>
    invoke<string>("append_ignore_pattern", { path, pattern, local }),

  /** Drop a tracked path from the index while keeping the worktree leaf. */
  stopTracking: (path: string, file: string) =>
    invoke<string>("stop_tracking", { path, file }),

  /** ADR 0003: true when restoring `file` from `commitOid` would change on-disk bytes. */
  worktreeDiffersFromCommit: (path: string, commitOid: string, file: string) =>
    invoke<boolean>("worktree_differs_from_commit", { path, commitOid, file }),

  /** ADR 0003: true when `file` has a restorable (non-gitlink) blob at `commitOid`. */
  commitPathIsRestorable: (path: string, commitOid: string, file: string) =>
    invoke<boolean>("commit_path_is_restorable", { path, commitOid, file }),

  /** ADR 0003: restore one path into the worktree from a commit (does not stage). */
  restorePathFromCommit: (path: string, commitOid: string, file: string) =>
    invoke<string>("restore_path_from_commit", { path, commitOid, file }),

  stageAll: (path: string) => invoke<string>("stage_all", { path }),

  unstageAll: (path: string) => invoke<string>("unstage_all", { path }),
};
