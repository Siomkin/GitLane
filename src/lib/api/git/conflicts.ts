// Conflict resolution: the in-progress operation, per-file conflict reads, the
// accept/resolve/re-conflict writes, and continue/abort/skip.
// Mirrors `commands/conflicts.rs`.

import { invoke } from "@/lib/api/invoke";
import { conflictFileContentSchema, operationStatusSchema } from "@/lib/api/schemas";
import { parse } from "@/lib/api/validate";
import { z } from "zod";

import { capturedIdentityArg } from "./capturedIdentity";
import type {
  ConflictFileContent,
  OperationKind,
  OperationStatus,
  RepoIdentity,
} from "./types";

export const conflictsApi = {
  /** The active merge/rebase/cherry-pick/revert operation + its conflicts. */
  operationStatus: async (path: string): Promise<OperationStatus> =>
    parse(operationStatusSchema, await invoke("operation_status", { path }), "operation_status"),

  /** Worktree copy of a conflicted text file (with `<<<<<<< ======= >>>>>>>`
   * markers) for the in-app editor to parse. */
  conflictFile: async (path: string, file: string): Promise<ConflictFileContent> =>
    parse(
      conflictFileContentSchema,
      await invoke("conflict_file", { path, file }),
      "conflict_file",
    ),

  /** Resolve a conflicted file by taking one whole side (`git checkout
   * --ours/--theirs` + stage; removes the file when that side deleted it). */
  acceptConflictSide: async (path: string, file: string, side: "ours" | "theirs") =>
    parse(
      z.string(),
      await invoke("accept_conflict_side", { path, file, side }),
      "accept_conflict_side",
    ),

  /** Write merged `content` to a conflicted file and stage it (the hunk editor's
   * reconstructed result). */
  resolveConflictFile: async (path: string, file: string, content: string) =>
    parse(
      z.string(),
      await invoke("resolve_conflict_file", { path, file, content }),
      "resolve_conflict_file",
    ),

  /** Stage a conflicted file as-is (mark resolved after a manual edit). */
  markConflictResolved: async (path: string, file: string) =>
    parse(
      z.string(),
      await invoke("mark_conflict_resolved", { path, file }),
      "mark_conflict_resolved",
    ),

  /** Restore conflict markers for an already-resolved file (`git checkout
   * --merge`) so it can be re-resolved. */
  reconflictFile: async (path: string, file: string) =>
    parse(z.string(), await invoke("reconflict_file", { path, file }), "reconflict_file"),

  /** Continue the active operation after staging resolutions. `name`/`email`
   * pin the bound identity onto the resulting commit (as `commit` does). */
  continueOperation: async (
    path: string,
    kind: OperationKind,
    name?: string | null,
    email?: string | null,
    identity?: RepoIdentity | null,
  ) =>
    parse(
      z.string(),
      await invoke("continue_operation", {
        path,
        kind,
        name: name ?? null,
        email: email ?? null,
        identity: capturedIdentityArg(identity),
      }),
      "continue_operation",
    ),

  /** Abort the active operation, restoring the pre-operation state. */
  abortOperation: async (path: string, kind: OperationKind) =>
    parse(z.string(), await invoke("abort_operation", { path, kind }), "abort_operation"),

  /** Skip the current commit in a sequencer operation (rebase/cherry-pick/revert).
   * A skip may immediately replay the next commit, so it carries the same
   * captured identity contract as continue. */
  skipOperation: async (
    path: string,
    kind: OperationKind,
    name?: string | null,
    email?: string | null,
    identity?: RepoIdentity | null,
  ) =>
    parse(
      z.string(),
      await invoke("skip_operation", {
        path,
        kind,
        name: name ?? null,
        email: email ?? null,
        identity: capturedIdentityArg(identity),
      }),
      "skip_operation",
    ),
};
