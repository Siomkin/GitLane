// Runtime schemas for `list_branches`, `list_reflog`, and `list_stashes` —
// mirrors `git/types/refs.ts`.

import { z } from "zod";
import type {
  BranchInfo,
  BranchSyncState,
  BranchSyncStatus,
  ReflogEntry,
  StashContextCommit,
  StashEntry,
} from "@/lib/api/git/types/refs";
import { assertEqual } from "./assertEqual";

const branchSyncStatusSchema = z.enum([
  "noRemote",
  "noUpstream",
  "staleUpstream",
  "unknown",
  "upToDate",
  "ahead",
  "behind",
  "diverged",
]);

const branchSyncStateSchema = z.object({
  status: branchSyncStatusSchema,
  upstream: z.string().nullable(),
  ahead: z.number(),
  behind: z.number(),
});

export const branchInfoSchema = z.object({
  name: z.string(),
  kind: z.enum(["local", "remote"]),
  target: z.string().nullable(),
  tipTime: z.number().nullish(),
  isHead: z.boolean(),
  upstream: z.string().nullable(),
  remote: z.string().nullable(),
  upstreamRemote: z.string().nullish(),
  pushRemote: z.string().nullish(),
  sync: branchSyncStateSchema.nullish(),
});

export const reflogEntrySchema = z.object({
  oid: z.string(),
  shortOid: z.string(),
  selector: z.string(),
  shortSelector: z.string(),
  refName: z.string(),
  subject: z.string(),
  committerName: z.string(),
  committerEmail: z.string(),
  timestamp: z.number(),
});

const stashContextCommitSchema = z.object({
  id: z.string(),
  shortId: z.string(),
  summary: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  timestamp: z.number(),
  parents: z.array(z.string()),
});

export const stashEntrySchema = z.object({
  index: z.number(),
  message: z.string(),
  oid: z.string(),
  timestamp: z.number(),
  baseOid: z.string().nullable(),
  baseTimestamp: z.number().nullable(),
  context: z.array(stashContextCommitSchema),
});

assertEqual<z.infer<typeof branchSyncStatusSchema>, BranchSyncStatus>(true);
assertEqual<z.infer<typeof branchSyncStateSchema>, BranchSyncState>(true);
assertEqual<z.infer<typeof branchInfoSchema>, BranchInfo>(true);
assertEqual<z.infer<typeof reflogEntrySchema>, ReflogEntry>(true);
assertEqual<z.infer<typeof stashContextCommitSchema>, StashContextCommit>(true);
assertEqual<z.infer<typeof stashEntrySchema>, StashEntry>(true);
