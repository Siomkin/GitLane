// Runtime schemas for `list_worktrees`, `worktree_dirty_state`, and
// `preview_remove_worktree` — mirrors `git/types/worktree.ts`.

import { z } from "zod";
import type {
  RemoveWorktreePreview,
  WorktreeDirtyState,
  WorktreeInfo,
} from "@/lib/api/git/types/worktree";
import { assertEqual } from "./assertEqual";
import { destructivePreviewSchema } from "./preview";

export const worktreeInfoSchema = z.object({
  name: z.string(),
  path: z.string(),
  branch: z.string().nullable(),
  head: z.string().nullish(),
  isMain: z.boolean(),
  bare: z.boolean().optional(),
  prunable: z.boolean().optional(),
  locked: z.boolean().optional(),
});

export const worktreeDirtyStateSchema = z.object({
  modified: z.number(),
  untracked: z.number(),
  ignored: z.number(),
});

export const removeWorktreePreviewSchema = destructivePreviewSchema.extend({
  expectedState: z.string(),
  requiresForce: z.boolean(),
  locked: z.boolean(),
  branch: z.string().nullable(),
  headOid: z.string().nullable(),
  dirty: worktreeDirtyStateSchema,
});

assertEqual<z.infer<typeof worktreeInfoSchema>, WorktreeInfo>(true);
assertEqual<z.infer<typeof worktreeDirtyStateSchema>, WorktreeDirtyState>(true);
assertEqual<z.infer<typeof removeWorktreePreviewSchema>, RemoveWorktreePreview>(true);
