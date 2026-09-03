// The reflog, the destructive-write previews that hand back the state lease a
// write must then present, the index-lock probe and its removal, and
// `discardAll` — the write those previews guard. Mirrors `commands/recovery.rs`.

import { invoke } from "@/lib/api/invoke";
import {
  deleteBranchPreviewSchema,
  destructivePreviewSchema,
  discardAllPreviewSchema,
  forcePushPreviewSchema,
  indexLockStatusSchema,
  reflogEntrySchema,
  resetPreviewSchema,
} from "@/lib/api/schemas";
import { parse } from "@/lib/api/validate";
import { z } from "zod";
import type {
  DeleteBranchPreview,
  DestructivePreview,
  DiscardAllPreview,
  ForcePushPreview,
  IndexLockStatus,
  ReflogEntry,
  ResetPreview,
} from "./types";

export const recoveryApi = {
  listReflog: async (path: string, limit?: number): Promise<ReflogEntry[]> =>
    parse(
      z.array(reflogEntrySchema),
      await invoke("list_reflog", { path, limit: limit ?? null }),
      "list_reflog",
    ),

  previewReset: async (
    path: string,
    target: string,
    mode: "soft" | "mixed" | "hard",
    // The ref being reset; omit for current-branch resets (defaults to HEAD).
    source?: string,
  ): Promise<ResetPreview> =>
    parse(
      resetPreviewSchema,
      await invoke("preview_reset", { path, target, mode, source: source ?? null }),
      "preview_reset",
    ),

  previewDiscardAll: async (path: string): Promise<DiscardAllPreview> =>
    parse(
      discardAllPreviewSchema,
      await invoke("preview_discard_all", { path }),
      "preview_discard_all",
    ),

  previewDeleteBranch: async (path: string, branch: string): Promise<DeleteBranchPreview> =>
    parse(
      deleteBranchPreviewSchema,
      await invoke("preview_delete_branch", { path, branch }),
      "preview_delete_branch",
    ),

  previewDeleteRemoteBranch: async (
    path: string,
    remote: string,
    branch: string,
  ): Promise<DestructivePreview> =>
    parse(
      destructivePreviewSchema,
      await invoke("preview_delete_remote_branch", { path, remote, branch }),
      "preview_delete_remote_branch",
    ),

  previewForcePush: async (path: string, branch: string): Promise<ForcePushPreview> =>
    parse(
      forcePushPreviewSchema,
      await invoke("preview_force_push", { path, branch }),
      "preview_force_push",
    ),

  /** Discard every uncommitted change: reset tracked files to HEAD and remove
   * untracked files/dirs. Irreversible. */
  discardAll: async (
    path: string,
    expectedState: string,
    expectedHeadBranch: string | null,
    expectedHeadOid: string | null,
  ) =>
    parse(
      z.string(),
      await invoke("discard_all", { path, expectedState, expectedHeadBranch, expectedHeadOid }),
      "discard_all",
    ),

  /** Inspect `.git/index.lock` for stranded-lock recovery (GL-335). */
  inspectIndexLock: async (path: string): Promise<IndexLockStatus> =>
    parse(
      indexLockStatusSchema,
      await invoke("inspect_index_lock", { path }),
      "inspect_index_lock",
    ),

  /** Remove a stranded `.git/index.lock` only when the staleness gate passes. */
  removeIndexLock: (path: string) => invoke<void>("remove_index_lock", { path }),
};
