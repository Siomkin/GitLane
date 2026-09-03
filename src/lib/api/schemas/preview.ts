// Runtime schemas for the destructive-operation previews, their leases, and the
// index-lock probe — mirrors `git/types/preview.ts`.

import { z } from "zod";
import type {
  DeleteBranchPreview,
  DestructivePreview,
  DiscardAllPreview,
  DiscardFilePreview,
  ForcePushPreview,
  ForcePushRouteLease,
  IndexLockStatus,
  ResetPreview,
} from "@/lib/api/git/types/preview";
import { assertEqual } from "./assertEqual";

export const destructivePreviewSchema = z.object({
  summary: z.string(),
  details: z.array(z.string()),
  warnings: z.array(z.string()),
});

export const resetPreviewSchema = destructivePreviewSchema.extend({
  targetOid: z.string(),
  expectedSourceOid: z.string().nullable(),
  expectedState: z.string().nullable(),
  expectedHeadBranch: z.string().nullable(),
  expectedHeadOid: z.string().nullable(),
});

const forcePushRouteLeaseSchema = z.object({
  remote: z.string(),
  destinationRef: z.string(),
  destinationOid: z.string().nullable(),
  pushEndpointToken: z.string(),
});

export const forcePushPreviewSchema = destructivePreviewSchema
  .extend(forcePushRouteLeaseSchema.shape)
  .extend({ expectedOid: z.string() });

export const deleteBranchPreviewSchema = destructivePreviewSchema.extend({
  expectedOid: z.string(),
});

export const discardFilePreviewSchema = destructivePreviewSchema.extend({
  expectedState: z.string(),
});

export const discardAllPreviewSchema = destructivePreviewSchema.extend({
  expectedState: z.string(),
  expectedHeadBranch: z.string().nullable(),
  expectedHeadOid: z.string().nullable(),
});

export const indexLockStatusSchema = z.object({
  present: z.boolean(),
  stale: z.boolean(),
  detail: z.string(),
});

assertEqual<z.infer<typeof destructivePreviewSchema>, DestructivePreview>(true);
assertEqual<z.infer<typeof resetPreviewSchema>, ResetPreview>(true);
assertEqual<z.infer<typeof forcePushRouteLeaseSchema>, ForcePushRouteLease>(true);
assertEqual<z.infer<typeof forcePushPreviewSchema>, ForcePushPreview>(true);
assertEqual<z.infer<typeof deleteBranchPreviewSchema>, DeleteBranchPreview>(true);
assertEqual<z.infer<typeof discardFilePreviewSchema>, DiscardFilePreview>(true);
assertEqual<z.infer<typeof discardAllPreviewSchema>, DiscardAllPreview>(true);
assertEqual<z.infer<typeof indexLockStatusSchema>, IndexLockStatus>(true);
