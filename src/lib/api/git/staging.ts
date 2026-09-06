// Index writes and the per-path working-tree operations beside them: stage and
// unstage whole files, folder roll-ups, hunks and lines, discard, ignore,
// untrack, and restore-from-commit. Mirrors `commands/staging.rs`.

import { invoke } from "@/lib/api/invoke";
import { applyLineRequestSchema, discardFilePreviewSchema } from "@/lib/api/schemas";
import { parse } from "@/lib/api/validate";
import { z } from "zod";
import type {
  ApplyLineRequest,
  DiscardFilePreview,
} from "./types";

export const stagingApi = {
  previewDiscardFile: async (
    path: string,
    file: string,
    previousFile: string | null,
    staged: boolean,
  ): Promise<DiscardFilePreview> =>
    parse(
      discardFilePreviewSchema,
      await invoke("preview_discard_file", { path, file, previousFile, staged }),
      "preview_discard_file",
    ),

  /** Stage one hunk from an unstaged diff, or unstage one hunk from a staged diff.
   * `expectedBody` is the displayed hunk's canonical body; the backend rejects the
   * stage if the current patch's hunk content no longer matches it. */
  applyHunk: async (
    path: string,
    file: string,
    staged: boolean,
    hunkIndex: number,
    expectedHeader: string,
    expectedBody: string,
  ) =>
    parse(
      z.string(),
      await invoke("apply_hunk", { path, file, staged, hunkIndex, expectedHeader, expectedBody }),
      "apply_hunk",
    ),

  /** Stage one changed line from an unstaged diff, or unstage one changed line from a staged diff. */
  applyLine: async (path: string, request: ApplyLineRequest) => {
    parse(applyLineRequestSchema, request, "apply_line");
    return parse(z.string(), await invoke("apply_line", { path, request }), "apply_line");
  },

  /** Stage several files atomically (one `git add -A`). */
  stageFiles: async (path: string, files: string[]) =>
    parse(z.string(), await invoke("stage_files", { path, files }), "stage_files"),

  /** Unstage several files atomically (one `git restore --staged`). */
  unstageFiles: async (path: string, files: string[]) =>
    parse(z.string(), await invoke("unstage_files", { path, files }), "unstage_files"),

  /** Discard one exact previewed file state. Staged changes restore from HEAD;
   * unstaged changes restore from the index. Renames carry `previousFile` so
   * both sides are handled as one logical change. */
  discardFile: async (
    path: string,
    file: string,
    previousFile: string | null,
    staged: boolean,
    expectedState: string,
  ) =>
    parse(
      z.string(),
      await invoke("discard_file", { path, file, previousFile, staged, expectedState }),
      "discard_file",
    ),

  /** Append one gitignore pattern to root `.gitignore`, or to `.git/info/exclude`
   * when `local` is true. */
  appendIgnorePattern: async (path: string, pattern: string, local: boolean) =>
    parse(
      z.string(),
      await invoke("append_ignore_pattern", { path, pattern, local }),
      "append_ignore_pattern",
    ),

  /** Drop a tracked path from the index while keeping the worktree leaf. */
  stopTracking: async (path: string, file: string) =>
    parse(z.string(), await invoke("stop_tracking", { path, file }), "stop_tracking"),

  /** ADR 0003: true when restoring `file` from `commitOid` would change on-disk bytes. */
  worktreeDiffersFromCommit: async (path: string, commitOid: string, file: string) =>
    parse(
      z.boolean(),
      await invoke("worktree_differs_from_commit", { path, commitOid, file }),
      "worktree_differs_from_commit",
    ),

  /** ADR 0003: true when `file` has a restorable (non-gitlink) blob at `commitOid`. */
  commitPathIsRestorable: async (path: string, commitOid: string, file: string) =>
    parse(
      z.boolean(),
      await invoke("commit_path_is_restorable", { path, commitOid, file }),
      "commit_path_is_restorable",
    ),

  /** ADR 0003: restore one path into the worktree from a commit (does not stage). */
  restorePathFromCommit: async (path: string, commitOid: string, file: string) =>
    parse(
      z.string(),
      await invoke("restore_path_from_commit", { path, commitOid, file }),
      "restore_path_from_commit",
    ),

  stageAll: async (path: string) =>
    parse(z.string(), await invoke("stage_all", { path }), "stage_all"),

  unstageAll: async (path: string) =>
    parse(z.string(), await invoke("unstage_all", { path }), "unstage_all"),
};
