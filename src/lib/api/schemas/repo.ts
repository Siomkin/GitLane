// Runtime schemas for `open_repo`, `recents_status`, `repo_forge`,
// `list_remotes`, and the identity reads — mirrors `git/types/repo.ts`.

import { z } from "zod";
import {
  ForgeKind,
  type ForgeCapabilities,
  type RecentStatus,
  type RemoteInfo,
  type RepoForge,
  type RepoIdentity,
  type RepoSummary,
  type SigningKey,
} from "@/lib/api/git/types/repo";
import { assertEqual } from "./assertEqual";

export const repoSummarySchema = z.object({
  path: z.string(),
  workdir: z.string().nullable(),
  headBranch: z.string().nullable(),
  headOid: z.string().nullable(),
  detached: z.boolean(),
  unborn: z.boolean(),
  isWorktree: z.boolean(),
  mainPath: z.string().nullish(),
});

export const repoIdentitySchema = z.object({
  name: z.string(),
  email: z.string(),
  signingKey: z.string().optional(),
  gpgFormat: z.string().optional(),
  gpgSign: z.boolean().optional(),
  tagGpgSign: z.boolean().optional(),
});

export const signingKeySchema = z.object({
  value: z.string(),
  label: z.string(),
  format: z.enum(["openpgp", "ssh"]),
});

export const recentStatusSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  branch: z.string().nullable(),
  isWorktree: z.boolean(),
  mainPath: z.string().nullish(),
});

const forgeKindSchema = z.enum(Object.values(ForgeKind));

export const forgeCapabilitiesSchema = z.object({
  create: z.boolean(),
  mergeMethods: z.array(z.enum(["merge", "squash", "rebase"])),
  stateActions: z.array(z.enum(["close", "reopen", "ready"])),
  deleteBranch: z.boolean(),
  stacks: z.boolean(),
});

export const repoForgeSchema = z.object({
  hasRemote: z.boolean(),
  kind: forgeKindSchema.nullable(),
  forge: z.string().nullable(),
  host: z.string().nullable(),
  webUrl: z.string().nullable(),
  capabilities: forgeCapabilitiesSchema.nullish(),
});

export const remoteInfoSchema = z.object({
  name: z.string(),
  fetchUrl: z.string(),
  pushUrl: z.string(),
  isDefault: z.boolean(),
});

assertEqual<z.infer<typeof repoSummarySchema>, RepoSummary>(true);
assertEqual<z.infer<typeof repoIdentitySchema>, RepoIdentity>(true);
assertEqual<z.infer<typeof signingKeySchema>, SigningKey>(true);
assertEqual<z.infer<typeof recentStatusSchema>, RecentStatus>(true);
assertEqual<z.infer<typeof forgeKindSchema>, ForgeKind>(true);
assertEqual<z.infer<typeof forgeCapabilitiesSchema>, ForgeCapabilities>(true);
assertEqual<z.infer<typeof repoForgeSchema>, RepoForge>(true);
assertEqual<z.infer<typeof remoteInfoSchema>, RemoteInfo>(true);
