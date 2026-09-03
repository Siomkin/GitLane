// Linked worktrees: listing, creating, removing, and moving a branch between
// them. Mirrors `commands/worktrees.rs`.

import { invoke } from "@/lib/api/invoke";
import {
  removeWorktreePreviewSchema,
  worktreeDirtyStateSchema,
  worktreeInfoSchema,
} from "@/lib/api/schemas";
import { parse } from "@/lib/api/validate";
import { z } from "zod";
import type {
  RemoveWorktreePreview,
  WorktreeDirtyState,
  WorktreeInfo,
} from "./types";

export const worktreesApi = {
  listWorktrees: async (path: string): Promise<WorktreeInfo[]> =>
    parse(z.array(worktreeInfoSchema), await invoke("list_worktrees", { path }), "list_worktrees"),

  /** Create a linked worktree at `worktreePath`. With `newBranch`, a fresh
   * branch of that name is created at `reference` (its start point) and checked
   * out there; otherwise the worktree is checked out to the explicit
   * `reference` directly (branch/tag/commit). */
  addWorktree: async (path: string, worktreePath: string, reference: string, newBranch?: string) =>
    parse(
      z.string(),
      await invoke("add_worktree", {
        path,
        worktreePath,
        reference,
        newBranch: newBranch ?? null,
      }),
      "add_worktree",
    ),

  /** Create a branch at the captured HEAD of an existing detached worktree and
   * check it out in that same worktree. */
  createBranchInWorktree: async (
    path: string,
    worktreePath: string,
    name: string,
    expectedOid: string,
  ) =>
    parse(
      z.string(),
      await invoke("create_branch_in_worktree", { path, worktreePath, name, expectedOid }),
      "create_branch_in_worktree",
    ),

  /** Hand `branch` off from one worktree to another (GL-74): detach the source,
   * check the branch out in `toWorktreePath`, and — when `carry` — bring the
   * source's uncommitted changes along in a stash. The destination's own
   * uncommitted work is preserved across the switch; a conflicting re-apply routes
   * into the conflict workspace as a `"carry"` operation. */
  moveBranchToWorktree: async (
    path: string,
    branch: string,
    fromWorktreePath: string,
    toWorktreePath: string,
    carry: boolean,
  ) =>
    parse(
      z.string(),
      await invoke("move_branch_to_worktree", {
        path,
        branch,
        fromWorktreePath,
        toWorktreePath,
        carry,
      }),
      "move_branch_to_worktree",
    ),

  /** Remove the linked worktree at `fromWorktreePath`, then delete the exact
   * previewed branch tip. Requires both the branch tip lease and the shared
   * Worktree Removal Lease from `previewRemoveWorktree` (GL-303). */
  deleteBranchWithWorktree: async (
    path: string,
    branch: string,
    fromWorktreePath: string,
    expectedOid: string,
    expectedState: string,
  ) =>
    parse(
      z.string(),
      await invoke("delete_branch_with_worktree", {
        path,
        branch,
        fromWorktreePath,
        expectedOid,
        expectedState,
      }),
      "delete_branch_with_worktree",
    ),

  /** Preview Linked Worktree Removal and capture the Worktree Removal Lease
   * (GL-303). Ignored entries are disclosed but not leased; force is a display
   * bit — execute derives it after the lease matches. */
  previewRemoveWorktree: async (path: string, worktreePath: string): Promise<RemoveWorktreePreview> =>
    parse(
      removeWorktreePreviewSchema,
      await invoke("preview_remove_worktree", { path, worktreePath }),
      "preview_remove_worktree",
    ),

  /** Remove a linked worktree using the exact Worktree Removal Lease from
   * `previewRemoveWorktree`. Force is server-derived after the lease matches. */
  removeWorktree: async (path: string, worktreePath: string, expectedState: string) =>
    parse(
      z.string(),
      await invoke("remove_worktree", { path, worktreePath, expectedState }),
      "remove_worktree",
    ),

  /** Uncommitted work sitting in a linked worktree, for the removal confirm to
   * quote before a forced remove discards it (GL-296). Probed on demand — it is
   * deliberately not a field on `WorktreeInfo`, whose list refreshes on every
   * filesystem event. Prefer `previewRemoveWorktree` when removing. */
  worktreeDirtyState: async (worktreePath: string): Promise<WorktreeDirtyState> =>
    parse(
      worktreeDirtyStateSchema,
      await invoke("worktree_dirty_state", { worktreePath }),
      "worktree_dirty_state",
    ),

  /** Whether a linked worktree currently holds uncommitted work — the single bit
   * behind the graph's dirty dot. Cheaper than `worktreeDirtyState` (no ignored
   * pass, untracked directories collapsed) because the dot needs no counts; it
   * is still a `git status`, so callers probe off the refresh path. */
  worktreeIsDirty: async (worktreePath: string) =>
    parse(
      z.boolean(),
      await invoke("worktree_is_dirty", { worktreePath }),
      "worktree_is_dirty",
    ),
};
