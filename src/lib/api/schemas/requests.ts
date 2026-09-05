// Strict request schemas for the bundled write commands. Unlike response
// schemas (which `.strip()` unknown fields for forward-compat), a misspelled
// optional expectation must fail immediately rather than silently drop a guard.

import { z } from "zod";
import type {
  ApplyLineRequest,
  CommitRequest,
  ResetToRequest,
  SquashBranchRequest,
  SquashCommitsRequest,
  SquashRangeRequest,
} from "@/lib/api/git/types/requests";
import type { CapturedIdentity } from "@/lib/api/git/types/repo";
import { repoIdentitySchema } from "./repo";
import { assertEqual } from "./assertEqual";

export const capturedIdentitySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("notCaptured") }),
  z.object({ mode: z.literal("capturedNone") }),
  z.object({ mode: z.literal("card"), identity: repoIdentitySchema }),
]);

const identityFields = {
  name: z.string().optional(),
  email: z.string().optional(),
  identity: capturedIdentitySchema,
};

export const commitRequestSchema = z
  .object({
    expectedBranch: z.string().optional(),
    expectedOid: z.string().optional(),
    summary: z.string(),
    description: z.string(),
    amend: z.boolean(),
    ...identityFields,
  })
  .strict();

export const squashCommitsRequestSchema = z
  .object({
    expectedBranch: z.string().optional(),
    expectedOid: z.string(),
    parentOid: z.string(),
    summary: z.string(),
    description: z.string(),
    ...identityFields,
  })
  .strict();

export const squashRangeRequestSchema = z
  .object({
    expectedBranch: z.string().optional(),
    expectedOid: z.string(),
    newestOid: z.string(),
    parentOid: z.string(),
    summary: z.string(),
    description: z.string(),
    ...identityFields,
  })
  .strict();

export const squashBranchRequestSchema = z
  .object({
    expectedBranch: z.string(),
    expectedOid: z.string(),
    newestOid: z.string(),
    parentOid: z.string(),
    summary: z.string(),
    description: z.string(),
    ...identityFields,
  })
  .strict();

export const applyLineRequestSchema = z
  .object({
    file: z.string(),
    staged: z.boolean(),
    hunkIndex: z.number(),
    lineIndex: z.number(),
    expectedKind: z.string(),
    expectedContent: z.string(),
    expectedOldNo: z.number().optional(),
    expectedNewNo: z.number().optional(),
  })
  .strict();

export const resetToRequestSchema = z
  .object({
    source: z.string().optional(),
    expectedSourceOid: z.string().optional(),
    targetOid: z.string(),
    mode: z.enum(["soft", "mixed", "hard"]),
    expectedState: z.string().optional(),
    expectedHeadBranch: z.string().optional(),
    expectedHeadOid: z.string().optional(),
  })
  .strict();

assertEqual<z.infer<typeof capturedIdentitySchema>, CapturedIdentity>(true);
assertEqual<z.infer<typeof commitRequestSchema>, CommitRequest>(true);
assertEqual<z.infer<typeof squashCommitsRequestSchema>, SquashCommitsRequest>(true);
assertEqual<z.infer<typeof squashRangeRequestSchema>, SquashRangeRequest>(true);
assertEqual<z.infer<typeof squashBranchRequestSchema>, SquashBranchRequest>(true);
assertEqual<z.infer<typeof applyLineRequestSchema>, ApplyLineRequest>(true);
assertEqual<z.infer<typeof resetToRequestSchema>, ResetToRequest>(true);
