// Runtime schemas for `file_diff` (and the commit/range/selection/compare
// variants) and `read_binary_blob` — mirrors `git/types/diff.ts`.

import { z } from "zod";
import type { BinaryBlob, DiffHunk, DiffLine, FileDiff } from "@/lib/api/git/types/diff";
import { assertEqual } from "./assertEqual";
import { fileStatusSchema } from "./status";

const diffLineSchema = z.object({
  kind: z.enum(["ctx", "add", "del"]),
  oldNo: z.number().nullable(),
  newNo: z.number().nullable(),
  content: z.string(),
});

const diffHunkSchema = z.object({
  header: z.string(),
  lines: z.array(diffLineSchema),
});

export const fileDiffSchema = z.object({
  path: z.string(),
  status: fileStatusSchema,
  add: z.number(),
  del: z.number(),
  binary: z.boolean(),
  hunks: z.array(diffHunkSchema),
  truncated: z.boolean(),
  oldSize: z.number().optional(),
  newSize: z.number().optional(),
  oldOid: z.string().optional(),
  newOid: z.string().optional(),
  commitOid: z.string().optional(),
  commitSubject: z.string().optional(),
});

export const binaryBlobSchema = z.object({
  base64: z.string().optional(),
  size: z.number(),
  truncated: z.boolean(),
});

assertEqual<z.infer<typeof diffLineSchema>, DiffLine>(true);
assertEqual<z.infer<typeof diffHunkSchema>, DiffHunk>(true);
assertEqual<z.infer<typeof fileDiffSchema>, FileDiff>(true);
assertEqual<z.infer<typeof binaryBlobSchema>, BinaryBlob>(true);
