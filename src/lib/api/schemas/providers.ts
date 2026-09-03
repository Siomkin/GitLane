// Runtime schemas for the non-GitHub provider auth surface (forge auth status,
// credential helpers, GitLane-owned provider tokens, native OAuth) — mirrors
// the response interfaces in `providers.ts`. Nothing here ever carries a secret.

import { z } from "zod";
import { ForgeKind } from "@/lib/api/git/types/repo";
import type {
  CredentialForgetResult,
  CredentialHelperStatus,
  CredentialSaveResult,
  ForgeAccount,
  ForgeAuthProvider,
  ForgeAuthStatus,
  OauthClientStatus,
  ProviderOauthResult,
  ProviderTokenStatus,
} from "@/lib/api/providers";
import { assertEqual } from "./assertEqual";

const forgeAuthProviderSchema = z.enum([
  "gitlab",
  "bitbucket",
  "azure-devops",
  "gitea",
  "forgejo",
  ForgeKind.CursorOrigin,
]);

export const forgeAccountSchema = z.object({
  username: z.string(),
  name: z.string().optional(),
});

export const forgeAuthStatusSchema = z.object({
  provider: forgeAuthProviderSchema,
  forge: z.string(),
  cli: z.string().nullable(),
  authMethod: z.string(),
  available: z.boolean(),
  authenticated: z.boolean().nullable(),
  loginCommand: z.string(),
  docsUrl: z.string(),
  notes: z.string(),
  account: forgeAccountSchema.optional(),
});

export const credentialHelperStatusSchema = z.object({
  configured: z.boolean(),
  helpers: z.array(z.string()),
});

export const credentialSaveResultSchema = z.object({
  username: z.string(),
  helper: z.string(),
});

export const credentialForgetResultSchema = z.object({
  helper: z.string(),
});

export const providerTokenStatusSchema = z.object({
  provider: z.string(),
  host: z.string(),
  accountId: z.string(),
  login: z.string(),
  hasToken: z.boolean(),
});

export const providerOauthResultSchema = z.object({
  provider: z.string(),
  host: z.string(),
  accountId: z.string(),
  login: z.string(),
  name: z.string().optional(),
  transportUsername: z.string(),
  hasToken: z.boolean(),
});

export const oauthClientStatusSchema = z.object({
  provider: z.string(),
  host: z.string(),
  configured: z.boolean(),
  source: z.string(),
  supported: z.boolean(),
});

assertEqual<z.infer<typeof forgeAuthProviderSchema>, ForgeAuthProvider>(true);
assertEqual<z.infer<typeof forgeAccountSchema>, ForgeAccount>(true);
assertEqual<z.infer<typeof forgeAuthStatusSchema>, ForgeAuthStatus>(true);
assertEqual<z.infer<typeof credentialHelperStatusSchema>, CredentialHelperStatus>(true);
assertEqual<z.infer<typeof credentialSaveResultSchema>, CredentialSaveResult>(true);
assertEqual<z.infer<typeof credentialForgetResultSchema>, CredentialForgetResult>(true);
assertEqual<z.infer<typeof providerTokenStatusSchema>, ProviderTokenStatus>(true);
assertEqual<z.infer<typeof providerOauthResultSchema>, ProviderOauthResult>(true);
assertEqual<z.infer<typeof oauthClientStatusSchema>, OauthClientStatus>(true);
