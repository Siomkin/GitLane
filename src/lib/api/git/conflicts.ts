// Conflict resolution: the in-progress operation, per-file conflict reads, the
// accept/resolve/re-conflict writes, and continue/abort/skip.
// Mirrors `commands/conflicts.rs`.

import { invoke } from "@tauri-apps/api/core";
import type {
  ConflictFileContent,
  OperationKind,
  OperationStatus,
  RepoIdentity,
} from "./types";

export const conflictsApi = {
  /** The active merge/rebase/cherry-pick/revert operation + its conflicts. */
  operationStatus: (path: string) =>
    invoke<OperationStatus>("operation_status", { path }),

  /** Worktree copy of a conflicted text file (with `<<<<<<< ======= >>>>>>>`
   * markers) for the in-app editor to parse. */
  conflictFile: (path: string, file: string) =>
    invoke<ConflictFileContent>("conflict_file", { path, file }),

  /** Resolve a conflicted file by taking one whole side (`git checkout
   * --ours/--theirs` + stage; removes the file when that side deleted it). */
  acceptConflictSide: (path: string, file: string, side: "ours" | "theirs") =>
    invoke<string>("accept_conflict_side", { path, file, side }),

  /** Write merged `content` to a conflicted file and stage it (the hunk editor's
   * reconstructed result). */
  resolveConflictFile: (path: string, file: string, content: string) =>
    invoke<string>("resolve_conflict_file", { path, file, content }),

  /** Stage a conflicted file as-is (mark resolved after a manual edit). */
  markConflictResolved: (path: string, file: string) =>
    invoke<string>("mark_conflict_resolved", { path, file }),

  /** Restore conflict markers for an already-resolved file (`git checkout
   * --merge`) so it can be re-resolved. */
  reconflictFile: (path: string, file: string) =>
    invoke<string>("reconflict_file", { path, file }),

  /** Continue the active operation after staging resolutions. `name`/`email`
   * pin the bound identity onto the resulting commit (as `commit` does). */
  continueOperation: (
    path: string,
    kind: OperationKind,
    name?: string | null,
    email?: string | null,
    identity?: RepoIdentity | null,
  ) =>
    invoke<string>("continue_operation", {
      path,
      kind,
      name: name ?? null,
      email: email ?? null,
      identity: identity ?? null,
      identityCaptured: identity !== undefined,
    }),

  /** Abort the active operation, restoring the pre-operation state. */
  abortOperation: (path: string, kind: OperationKind) =>
    invoke<string>("abort_operation", { path, kind }),

  /** Skip the current commit in a sequencer operation (rebase/cherry-pick/revert).
   * A skip may immediately replay the next commit, so it carries the same
   * captured identity contract as continue. */
  skipOperation: (
    path: string,
    kind: OperationKind,
    name?: string | null,
    email?: string | null,
    identity?: RepoIdentity | null,
  ) =>
    invoke<string>("skip_operation", {
      path,
      kind,
      name: name ?? null,
      email: email ?? null,
      identity: identity ?? null,
      identityCaptured: identity !== undefined,
    }),
};
