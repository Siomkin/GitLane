// Runtime schemas for `working_changes` and the `FileChange[]` reads
// (`commit_files`, `diff_range`, `selection_diff`) — mirrors `git/types/status.ts`.

import { z } from "zod";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import type {
  AdvancedRepoState,
  FileAdvancedState,
  FileChange,
  FileStatus,
  LfsState,
  SparseCheckoutState,
  SubmoduleState,
  WorkingChanges,
} from "@/lib/api/git/types/status";
import { assertEqual } from "./assertEqual";

export const fileStatusSchema = z.enum(["M", "A", "D", "R", "C", "T", "U", "X"]);

const fileAdvancedStateSchema = z.object({
  kind: z.enum(["submodule", "sparse"]),
  message: z.string(),
});

export const fileChangeSchema = z.object({
  path: z.string(),
  status: fileStatusSchema,
  add: z.number(),
  del: z.number(),
  binary: z.boolean(),
  lineCountTruncated: z.boolean().optional(),
  previousPath: z.string().optional(),
  advanced: fileAdvancedStateSchema.optional(),
});

const submoduleStateSchema = z.object({
  path: z.string(),
  name: z.string(),
  url: z.string().nullable(),
  status: z.string(),
  details: z.array(z.string()),
  dirty: z.boolean(),
  initialized: z.boolean(),
});

const lfsStateSchema = z.object({
  detected: z.boolean(),
  installed: z.boolean().nullable(),
  issues: z.array(z.string()),
  patterns: z.array(z.string()),
});

const sparseCheckoutStateSchema = z.object({
  enabled: z.boolean(),
  mode: z.string().nullable(),
  patterns: z.array(z.string()),
  truncated: z.boolean(),
});

const advancedRepoStateSchema = z.object({
  submodules: z.array(submoduleStateSchema),
  lfs: lfsStateSchema,
  sparseCheckout: sparseCheckoutStateSchema,
});

export const workingChangesSchema = z.object({
  staged: z.array(fileChangeSchema),
  unstaged: z.array(fileChangeSchema),
  // The backend always sends `conflicted`, but default it so a malformed/legacy
  // payload still normalizes to [] (the long-standing defensive contract) rather
  // than throwing — every consumer can keep relying on the field being present.
  conflicted: z.array(fileChangeSchema).default([]),
  // Always sent by the backend; defaulted (like `conflicted`) so a malformed or
  // legacy payload still normalizes to an empty advanced state rather than
  // throwing, while the parsed type stays non-optional.
  advanced: advancedRepoStateSchema.default(emptyAdvancedState),
});

assertEqual<z.infer<typeof fileStatusSchema>, FileStatus>(true);
assertEqual<z.infer<typeof fileAdvancedStateSchema>, FileAdvancedState>(true);
assertEqual<z.infer<typeof fileChangeSchema>, FileChange>(true);
assertEqual<z.infer<typeof submoduleStateSchema>, SubmoduleState>(true);
assertEqual<z.infer<typeof lfsStateSchema>, LfsState>(true);
assertEqual<z.infer<typeof sparseCheckoutStateSchema>, SparseCheckoutState>(true);
assertEqual<z.infer<typeof advancedRepoStateSchema>, AdvancedRepoState>(true);
assertEqual<z.infer<typeof workingChangesSchema>, WorkingChanges>(true);
