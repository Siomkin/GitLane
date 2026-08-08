// Linked worktrees: listing, creating, removing, and moving a branch between
// them. Mirrors `commands/worktrees.rs`.

import { invoke } from "@tauri-apps/api/core";
import type {
  RemoveWorktreePreview,
  WorktreeDirtyState,
  WorktreeInfo,
} from "./types";

export const worktreesApi = {
  listWorktrees: (path: string) =>
    invoke<WorktreeInfo[]>("list_worktrees", { path }),

  /** Create a linked worktree at `worktreePath`. With `newBranch`, a fresh
   * branch of that name is created at `reference` (its start point) and checked
   * out there; otherwise the worktree is checked out to the explicit
   * `reference` directly (branch/tag/commit). */
  addWorktree: (path: string, worktreePath: string, reference: string, newBranch?: string) =>
    invoke<string>("add_worktree", {
      path,
      worktreePath,
      reference,
      newBranch: newBranch ?? null,
    }),

  /** Create a branch at the captured HEAD of an existing detached worktree and
   * check it out in that same worktree. */
  createBranchInWorktree: (
    path: string,
    worktreePath: string,
    name: string,
    expectedOid: string,
  ) =>
    invoke<string>("create_branch_in_worktree", {
      path,
      worktreePath,
      name,
      expectedOid,
    }),

  /** Hand `branch` off from one worktree to another (GL-74): detach the source,
   * check the branch out in `toWorktreePath`, and — when `carry` — bring the
   * source's uncommitted changes along in a stash. The destination's own
   * uncommitted work is preserved across the switch; a conflicting re-apply routes
   * into the conflict workspace as a `"carry"` operation. */
  moveBranchToWorktree: (
    path: string,
    branch: string,
    fromWorktreePath: string,
    toWorktreePath: string,
    carry: boolean,
  ) =>
    invoke<string>("move_branch_to_worktree", {
      path,
      branch,
      fromWorktreePath,
      toWorktreePath,
      carry,
    }),

  /** Remove the linked worktree at `fromWorktreePath`, then delete the exact
   * previewed branch tip. Requires both the branch tip lease and the shared
   * Worktree Removal Lease from `previewRemoveWorktree` (GL-303). */
  deleteBranchWithWorktree: (
    path: string,
    branch: string,
    fromWorktreePath: string,
    expectedOid: string,
    expectedState: string,
  ) =>
    invoke<string>("delete_branch_with_worktree", {
      path,
      branch,
      fromWorktreePath,
      expectedOid,
      expectedState,
    }),

  /** Preview Linked Worktree Removal and capture the Worktree Removal Lease
   * (GL-303). Ignored entries are disclosed but not leased; force is a display
   * bit — execute derives it after the lease matches. */
  previewRemoveWorktree: (path: string, worktreePath: string) =>
    invoke<RemoveWorktreePreview>("preview_remove_worktree", { path, worktreePath }),

  /** Remove a linked worktree using the exact Worktree Removal Lease from
   * `previewRemoveWorktree`. Force is server-derived after the lease matches. */
  removeWorktree: (path: string, worktreePath: string, expectedState: string) =>
    invoke<string>("remove_worktree", { path, worktreePath, expectedState }),

  /** Uncommitted work sitting in a linked worktree, for the removal confirm to
   * quote before a forced remove discards it (GL-296). Probed on demand — it is
   * deliberately not a field on `WorktreeInfo`, whose list refreshes on every
   * filesystem event. Prefer `previewRemoveWorktree` when removing. */
  worktreeDirtyState: (worktreePath: string) =>
    invoke<WorktreeDirtyState>("worktree_dirty_state", { worktreePath }),

  /** Whether a linked worktree currently holds uncommitted work — the single bit
   * behind the graph's dirty dot. Cheaper than `worktreeDirtyState` (no ignored
   * pass, untracked directories collapsed) because the dot needs no counts; it
   * is still a `git status`, so callers probe off the refresh path. */
  worktreeIsDirty: (worktreePath: string) =>
    invoke<boolean>("worktree_is_dirty", { worktreePath }),
};
