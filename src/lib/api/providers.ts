import { invoke } from "@/lib/api/invoke";
import {
  credentialForgetResultSchema,
  credentialHelperStatusSchema,
  credentialSaveResultSchema,
  forgeAccountSchema,
  forgeAuthStatusSchema,
  oauthClientStatusSchema,
  providerOauthResultSchema,
  providerTokenStatusSchema,
} from "@/lib/api/schemas";
import { parse } from "@/lib/api/validate";
import { z } from "zod";

import { ForgeKind } from "./git/types/repo";

export type ForgeAuthProvider =
  | "gitlab"
  | "bitbucket"
  | "azure-devops"
  | "gitea"
  | "forgejo"
  | typeof ForgeKind.CursorOrigin;

/** Real signed-in account on a non-GitHub provider (from its CLI whoami).
 * Identity metadata only — never a token. */
export interface ForgeAccount {
  username: string;
  name?: string;
}

export interface ForgeAuthStatus {
  provider: ForgeAuthProvider;
  forge: string;
  cli: string | null;
  authMethod: string;
  available: boolean;
  authenticated: boolean | null;
  loginCommand: string;
  docsUrl: string;
  notes: string;
  /** Present only when authenticated and GitLane could resolve the account. */
  account?: ForgeAccount;
}

export interface CredentialHelperStatus {
  configured: boolean;
  helpers: string[];
}

export interface CredentialSaveResult {
  username: string;
  helper: string;
}

export interface CredentialForgetResult {
  helper: string;
}

/** Non-secret status of a GitLane-owned provider token (GL-132). Never carries
 * the token itself — `hasToken` reports keychain presence only. */
export interface ProviderTokenStatus {
  provider: string;
  host: string;
  accountId: string;
  login: string;
  hasToken: boolean;
}

/** Result of a completed native OAuth sign-in (GL-139). No token — the access
 * token is written straight to the OS keychain in Rust. `transportUsername` is
 * the git HTTPS username an OAuth token authenticates as (`oauth2` for GitLab,
 * `x-token-auth` for Bitbucket), which is not the human `login`. */
export interface ProviderOauthResult {
  provider: string;
  host: string;
  accountId: string;
  login: string;
  name?: string;
  transportUsername: string;
  hasToken: boolean;
}

/** Whether native OAuth is configured for a provider/host (GL-139), and where
 * its public client id comes from. Never carries the client id itself. */
export interface OauthClientStatus {
  provider: string;
  host: string;
  configured: boolean;
  /** "builtin" | "override" | "none". */
  source: string;
  supported: boolean;
}

/** One `provider-oauth-progress` event payload (GL-139). Display-safe only — the
 * device code (secret half) is never emitted; `userCode` is the human code. */
export interface ProviderOauthProgress {
  provider: string;
  step: string;
  userCode?: string;
  verificationUri?: string;
  expiresInSecs?: number;
}

export const providersApi = {
  /** Auth-only status for non-GitHub forge providers (fast; no identity). */
  forgeAuthStatuses: async (): Promise<ForgeAuthStatus[]> =>
    parse(
      z.array(forgeAuthStatusSchema),
      await invoke("forge_auth_statuses"),
      "forge_auth_statuses",
    ),
  /** Resolve the signed-in account for one provider (a network whoami; slow). */
  forgeAccount: async (provider: ForgeAuthProvider): Promise<ForgeAccount | null> =>
    parse(
      forgeAccountSchema.nullable(),
      await invoke("forge_account", { provider }),
      "forge_account",
    ),
  forgeSignOut: async (provider: ForgeAuthProvider) =>
    parse(z.string(), await invoke("forge_sign_out", { provider }), "forge_sign_out"),
  credentialHelperStatus: async (): Promise<CredentialHelperStatus> =>
    parse(
      credentialHelperStatusSchema,
      await invoke("credential_helper_status"),
      "credential_helper_status",
    ),
  approveHttpsCredential: async (
    credentialHost: string,
    path: string | null,
    username: string,
    password: string,
  ): Promise<CredentialSaveResult> =>
    parse(
      credentialSaveResultSchema,
      await invoke("approve_https_credential", { credentialHost, path, username, password }),
      "approve_https_credential",
    ),
  /** Forget a saved HTTPS credential from the user's Git credential helper
   * (`git credential reject`). Distinct from provider sign-out — see
   * {@link deleteProviderToken}. */
  rejectHttpsCredential: async (
    credentialHost: string,
    path: string | null,
    username: string,
  ): Promise<CredentialForgetResult> =>
    parse(
      credentialForgetResultSchema,
      await invoke("reject_https_credential", { credentialHost, path, username }),
      "reject_https_credential",
    ),
  /** Store a provider account's transport token in the OS keychain (GL-132). The
   * token is sent once and never returned; only non-secret status comes back. */
  saveProviderToken: async (
    provider: ForgeAuthProvider,
    host: string,
    accountId: string,
    login: string,
    token: string,
  ): Promise<ProviderTokenStatus> =>
    parse(
      providerTokenStatusSchema,
      await invoke("save_provider_token", { provider, host, accountId, login, token }),
      "save_provider_token",
    ),
  /** Delete a GitLane-owned provider token from the keychain — provider
   * sign-out. Idempotent; leaves the user's git credential-helper creds alone. */
  deleteProviderToken: (provider: ForgeAuthProvider, host: string, accountId: string) =>
    invoke<void>("delete_provider_token", { provider, host, accountId }),
  /** Whether a keychain token is currently stored for a provider account. */
  providerTokenStatus: async (
    provider: ForgeAuthProvider,
    host: string,
    accountId: string,
    login: string,
  ): Promise<ProviderTokenStatus> =>
    parse(
      providerTokenStatusSchema,
      await invoke("provider_token_status", { provider, host, accountId, login }),
      "provider_token_status",
    ),
  /** Run a native OAuth sign-in (GL-139): GitLab's device flow or Bitbucket's
   * PKCE loopback. Emits `provider-oauth-progress` events; resolves with
   * non-secret account metadata once the token is in the keychain. Rejects on
   * failure or when cancelled via {@link cancelProviderOauthSignIn}. */
  providerOauthSignIn: async (
    provider: ForgeAuthProvider,
    host: string,
  ): Promise<ProviderOauthResult> =>
    parse(
      providerOauthResultSchema,
      await invoke("provider_oauth_sign_in", { provider, host }),
      "provider_oauth_sign_in",
    ),
  /** Cancel an in-flight {@link providerOauthSignIn}, discarding any codes. */
  cancelProviderOauthSignIn: () => invoke<void>("cancel_provider_oauth_sign_in"),
  /** Whether native OAuth is configured for a provider/host (GL-139). */
  oauthClientStatus: async (provider: ForgeAuthProvider, host: string): Promise<OauthClientStatus> =>
    parse(
      oauthClientStatusSchema,
      await invoke("oauth_client_status", { provider, host }),
      "oauth_client_status",
    ),
  /** Set (or clear, when empty) the per-host public OAuth client id (GL-139). */
  setOauthClientId: (provider: ForgeAuthProvider, host: string, clientId: string) =>
    invoke<void>("set_oauth_client_id", { provider, host, clientId }),
  /** Drop the backend's cached external-tool probes (git version, gh / origin
   * capabilities, glab presence) so the next operation re-detects each tool —
   * how a CLI installed or upgraded mid-session is seen without a relaunch.
   * Stores call it before an account add/remove and from the PR-list retry. */
  refreshToolProbes: () => invoke<void>("refresh_tool_probes"),
};
