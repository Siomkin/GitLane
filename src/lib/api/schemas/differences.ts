// Runtime schemas for `working_file_differences` and the strict line-range
// request — mirrors `git/types/differences.ts`.

import { z } from "zod";
import type {
  ApplyLineRangeRequest,
  Difference,
  DiffLineRange,
  FileDifferences,
} from "@/lib/api/git/types/differences";
import { assertEqual } from "./assertEqual";
import { diffLineSchema, fileDiffSchema } from "./diff";

const diffLineRangeSchema = z.object({
  hunkIndex: z.number(),
  lineStart: z.number(),
  expected: z.array(diffLineSchema),
});

const differenceSchema = z.object({
  hunkIndex: z.number(),
  lineStart: z.number(),
  lineEnd: z.number(),
  inclusion: z.enum(["included", "excluded", "partial"]),
  stage: z.array(diffLineRangeSchema),
  unstage: z.array(diffLineRangeSchema),
});

export const fileDifferencesSchema = z.object({
  diff: fileDiffSchema,
  differences: z.array(differenceSchema),
  wholeFile: z.boolean(),
});

/** Strict, like every request schema: a misspelled guard must fail, not drop. */
export const applyLineRangeRequestSchema = z
  .object({
    file: z.string(),
    staged: z.boolean(),
    ranges: z.array(diffLineRangeSchema.strict()),
  })
  .strict();

assertEqual<z.infer<typeof diffLineRangeSchema>, DiffLineRange>(true);
assertEqual<z.infer<typeof differenceSchema>, Difference>(true);
assertEqual<z.infer<typeof fileDifferencesSchema>, FileDifferences>(true);
assertEqual<z.infer<typeof applyLineRangeRequestSchema>, ApplyLineRangeRequest>(true);
