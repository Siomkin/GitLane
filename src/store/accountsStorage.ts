// The localStorage metadata layer behind `accounts.ts`: the per-repo binding /
// identity / credential-marker / keychain-token-metadata maps, their typed
// read/write wrappers, and the lookups over them. No Zustand, no IPC — the
// store composes these; nothing here ever holds token material.

import { z } from "zod";
import type { ForgeAuthProvider, GithubAccountRef, RepoIdentity } from "@/lib/api";
import { ForgeKind } from "@/lib/api";
import type { StoredRepoAccountEntry } from "./accountBindings";

// Per-repo PR-account bindings. Per-remote auth moved to git config (URL
// usernames); older v2 (repo-wide) and interim v3 (per-remote) values are
// migrated once the remote list is known. The commit identity (name + email)
// is stored separately so it can be edited independently of the auth account.
const LS_REPO_ACCOUNTS = "gitlane.repoAccounts";
const LS_REPO_IDENTITY = "gitlane.repoIdentity";
const LS_FORGE_CREDENTIALS = "gitlane.forgeCredentials";
const LS_PROVIDER_TOKENS = "gitlane.providerTokens";

export type StoredForgeCredential = {
  provider: ForgeAuthProvider;
  credentialHost: string;
  path: string | null;
  username: string;
  helper: string;
  savedAt: number;
};

/** Non-secret metadata for a GitLane-owned provider token (GL-132). The token
 * itself lives only in the OS keychain; this record just remembers *that* a
 * token exists for an account so the transport layer can select `providerToken`
 * mode and the UI can show sign-out. Never contains token material.
 *
 * Always replace an entry wholesale; never mutate one in place — reconciliation
 * pins its compare-and-delete on object identity, so an in-place edit would let
 * a stale keychain probe wipe metadata it never probed (GL-168). */
export type StoredProviderToken = {
  provider: ForgeAuthProvider;
  /** Exact credential authority (`host[:port]`) — the keychain host locator. */
  credentialHost: string;
  /** Stable keychain account id (the login for a PAT sign-in; the provider's
   * stable account id for an OAuth sign-in). */
  accountId: string;
  /** Human display handle. */
  login: string;
  /** The git HTTPS URL username this token authenticates as, when it differs
   * from `login` — set for OAuth accounts, whose token authenticates as a
   * sentinel (`oauth2` / `x-token-auth`) rather than the human handle (GL-139).
   * Absent for PAT sign-ins, where the URL username *is* the login. This is the
   * key component (and the value pinned into the remote URL). */
  transportUsername?: string;
  savedAt: number;
};

/** Metadata map key: a stored token is looked up by the remote's credential host
 * + URL username, both lowercased so matching is case-insensitive. Joined with a
 * NUL — which appears in neither a host nor a login — so the two fields can never
 * collide (the `\0`-separated key idiom used elsewhere in this store). */
export const providerTokenKey = (credentialHost: string, login: string) =>
  `${credentialHost.trim().toLowerCase()}\u0000${login.trim().toLowerCase()}`;

const nonEmptyString = z.string().trim().min(1);
const forgeAuthProviderSchema = z.enum([
  "gitlab",
  "bitbucket",
  "azure-devops",
  "gitea",
  "forgejo",
  ForgeKind.CursorOrigin,
]);
const githubAccountRefShape = {
  provider: z.enum(["gh", "native"]),
  host: nonEmptyString,
  accountId: nonEmptyString,
  login: nonEmptyString,
};
// Bindings and identities are non-secret, forward-compatible metadata. Strip
// fields written by a newer app so a beta -> stable rollback keeps the known
// row instead of erasing it on the next read/modify/write. Credential and token
// schemas below stay strict because unexpected fields there may be secret data.
const githubAccountRefSchema: z.ZodType<GithubAccountRef> = z.object(
  githubAccountRefShape,
);
const unboundSchema = z.object({ unbound: z.literal(true) });
const remoteBindingSchema = z.union([githubAccountRefSchema, unboundSchema, nonEmptyString]);
const storedRepoAccountEntrySchema: z.ZodType<StoredRepoAccountEntry> = z.union([
  z.object({ version: z.literal(2), unbound: z.literal(true) }),
  z.object({ ...githubAccountRefShape, version: z.literal(2) }),
  z.object({
    version: z.literal(3),
    remotes: z.record(z.string(), remoteBindingSchema),
  }),
  nonEmptyString,
]);
const repoIdentitySchema: z.ZodType<RepoIdentity> = z.object({
  name: z.string(),
  email: z.string(),
  signingKey: z.string().optional(),
  gpgFormat: z.string().optional(),
  gpgSign: z.boolean().optional(),
  tagGpgSign: z.boolean().optional(),
});
const storedForgeCredentialSchema: z.ZodType<StoredForgeCredential> = z.strictObject({
  provider: forgeAuthProviderSchema,
  credentialHost: nonEmptyString,
  path: z.string().nullable(),
  username: nonEmptyString,
  helper: z.string(),
  savedAt: z.number().finite(),
});
const storedProviderTokenSchema: z.ZodType<StoredProviderToken> = z.strictObject({
  provider: forgeAuthProviderSchema,
  credentialHost: nonEmptyString,
  accountId: nonEmptyString,
  login: nonEmptyString,
  transportUsername: nonEmptyString.optional(),
  savedAt: z.number().finite(),
});

type EntryGuard<T> = (mapKey: string, value: T) => boolean;

/** Parse persisted metadata as untrusted input. Keep independently valid rows
 * so one corrupt entry cannot discard every account, but never let an invalid
 * shape (or an unexpected field such as token material) enter store state. */
function readJsonMap<T>(key: string, schema: z.ZodType<T>, guard?: EntryGuard<T>): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const valid: Array<[string, T]> = [];
    for (const [mapKey, candidate] of Object.entries(parsed)) {
      const result = schema.safeParse(candidate);
      if (result.success && (!guard || guard(mapKey, result.data))) {
        valid.push([mapKey, result.data]);
      }
    }
    return Object.fromEntries(valid);
  } catch {
    return {};
  }
}

function writeJsonMap<T>(key: string, map: Record<string, T>) {
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    /* ignore quota / unavailable */
  }
}

export const readBindings = () =>
  readJsonMap(LS_REPO_ACCOUNTS, storedRepoAccountEntrySchema, (key) => key.trim() !== "");
export const writeBindings = (map: Record<string, StoredRepoAccountEntry>) =>
  writeJsonMap(LS_REPO_ACCOUNTS, map);
export const readIdentities = () =>
  readJsonMap(LS_REPO_IDENTITY, repoIdentitySchema, (key) => key.trim() !== "");
export const writeIdentities = (map: Record<string, RepoIdentity>) =>
  writeJsonMap(LS_REPO_IDENTITY, map);
export const readForgeCredentials = () =>
  readJsonMap(
    LS_FORGE_CREDENTIALS,
    storedForgeCredentialSchema,
    (key, credential) => key === credential.provider,
  );
export const writeForgeCredentials = (map: Record<string, StoredForgeCredential>) =>
  writeJsonMap(LS_FORGE_CREDENTIALS, map);
export const readProviderTokens = () =>
  readJsonMap(LS_PROVIDER_TOKENS, storedProviderTokenSchema, (key, token) => {
    const transportLogin = token.transportUsername ?? token.login;
    return key === providerTokenKey(token.credentialHost, transportLogin);
  });
export const writeProviderTokens = (map: Record<string, StoredProviderToken>) =>
  writeJsonMap(LS_PROVIDER_TOKENS, map);

/** The keychain token to use for `credentialHost`, chosen deterministically when
 * several tokens share a host (an OAuth token + a PAT): prefer the OAuth token
 * (it carries a sentinel transport username), then the most recently saved.
 * Shared by transport and the clone flow so both resolve the same one. When
 * `provider` is given, only tokens for that provider family match — the PR-account
 * resolution scopes to the repo's forge so a co-hosted token for another provider
 * can't be picked (GL-141). */
export function pickProviderTokenForHost(
  tokens: Record<string, StoredProviderToken>,
  credentialHost: string,
  provider?: ForgeAuthProvider,
): StoredProviderToken | undefined {
  const norm = (h: string) => h.trim().toLowerCase();
  return Object.values(tokens)
    .filter((t) => norm(t.credentialHost) === norm(credentialHost))
    .filter((t) => provider === undefined || t.provider === provider)
    .sort((a, b) => (b.transportUsername ? 1 : 0) - (a.transportUsername ? 1 : 0) || b.savedAt - a.savedAt)[0];
}

/** One-shot migration of a per-repo map entry from a worktree-path key to the
 * repository-identity key (GL-109): pre-identity builds stored bindings under
 * whatever worktree path was open, so a value under `path` moves to `key` (the
 * identity wins if both exist — the stale worktree shadow is dropped). Returns
 * true when the map changed and needs persisting. */
export function migratePathKey<T>(map: Record<string, T>, key: string, path: string): boolean {
  if (key === path || map[path] === undefined) return false;
  if (map[key] === undefined) map[key] = map[path];
  delete map[path];
  return true;
}
