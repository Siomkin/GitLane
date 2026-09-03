// Runtime schemas for `operation_status` and `conflict_file` — mirrors
// `git/types/conflicts.ts`.

import { z } from "zod";
import type {
  ConflictFile,
  ConflictFileContent,
  OperationAdvisory,
  OperationKind,
  OperationStatus,
} from "@/lib/api/git/types/conflicts";
import { assertEqual } from "./assertEqual";

const operationKindSchema = z.enum(["merge", "rebase", "cherry-pick", "revert", "carry", "none"]);

const operationAdvisorySchema = z.enum(["apply-mailbox", "bisect", ""]);

const conflictFileSchema = z.object({
  path: z.string(),
  kind: z.enum(["text", "binary", "deleted"]),
  deletedSide: z.enum(["ours", "theirs", "both", ""]),
});

export const operationStatusSchema = z.object({
  kind: operationKindSchema,
  canSkip: z.boolean(),
  conflicts: z.array(conflictFileSchema),
  advisory: operationAdvisorySchema,
});

export const conflictFileContentSchema = z.object({
  path: z.string(),
  content: z.string(),
  binary: z.boolean(),
});

assertEqual<z.infer<typeof operationKindSchema>, OperationKind>(true);
assertEqual<z.infer<typeof operationAdvisorySchema>, OperationAdvisory>(true);
assertEqual<z.infer<typeof conflictFileSchema>, ConflictFile>(true);
assertEqual<z.infer<typeof operationStatusSchema>, OperationStatus>(true);
assertEqual<z.infer<typeof conflictFileContentSchema>, ConflictFileContent>(true);
