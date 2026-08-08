// The reflog, the destructive-write previews that hand back the state lease a
// write must then present, the index-lock probe and its removal, and
// `discardAll` — the write those previews guard. Mirrors `commands/recovery.rs`.

import { invoke } from "@tauri-apps/api/core";
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
  listReflog: (path: string, limit?: number) =>
    invoke<ReflogEntry[]>("list_reflog", { path, limit: limit ?? null }),

  previewReset: (
    path: string,
    target: string,
    mode: "soft" | "mixed" | "hard",
    // The ref being reset; omit for current-branch resets (defaults to HEAD).
    source?: string,
  ) => invoke<ResetPreview>("preview_reset", { path, target, mode, source: source ?? null }),

  previewDiscardAll: (path: string) =>
    invoke<DiscardAllPreview>("preview_discard_all", { path }),

  previewDeleteBranch: (path: string, branch: string) =>
    invoke<DeleteBranchPreview>("preview_delete_branch", { path, branch }),

  previewDeleteRemoteBranch: (path: string, remote: string, branch: string) =>
    invoke<DestructivePreview>("preview_delete_remote_branch", { path, remote, branch }),

  previewForcePush: (path: string, branch: string) =>
    invoke<ForcePushPreview>("preview_force_push", { path, branch }),

  /** Discard every uncommitted change: reset tracked files to HEAD and remove
   * untracked files/dirs. Irreversible. */
  discardAll: (
    path: string,
    expectedState: string,
    expectedHeadBranch: string | null,
    expectedHeadOid: string | null,
  ) => invoke<string>("discard_all", {
    path,
    expectedState,
    expectedHeadBranch,
    expectedHeadOid,
  }),

  /** Inspect `.git/index.lock` for stranded-lock recovery (GL-335). */
  inspectIndexLock: (path: string) => invoke<IndexLockStatus>("inspect_index_lock", { path }),

  /** Remove a stranded `.git/index.lock` only when the staleness gate passes. */
  removeIndexLock: (path: string) => invoke<void>("remove_index_lock", { path }),
};
