import { invoke } from "@tauri-apps/api/core";

export type ForgeAuthProvider =
  | "gitlab"
  | "bitbucket"
  | "azure-devops"
  | "gitea"
  | "forgejo";

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

export const providersApi = {
  /** Auth-only status for non-GitHub forge providers (fast; no identity). */
  forgeAuthStatuses: () => invoke<ForgeAuthStatus[]>("forge_auth_statuses"),
  /** Resolve the signed-in account for one provider (a network whoami; slow). */
  forgeAccount: (provider: ForgeAuthProvider) =>
    invoke<ForgeAccount | null>("forge_account", { provider }),
  forgeSignOut: (provider: ForgeAuthProvider) => invoke<string>("forge_sign_out", { provider }),
  credentialHelperStatus: () => invoke<CredentialHelperStatus>("credential_helper_status"),
  approveHttpsCredential: (
    credentialHost: string,
    path: string | null,
    username: string,
    password: string,
  ) =>
    invoke<CredentialSaveResult>("approve_https_credential", {
      credentialHost,
      path,
      username,
      password,
    }),
  /** Forget a saved HTTPS credential from the user's Git credential helper
   * (`git credential reject`). Distinct from provider sign-out — see
   * {@link deleteProviderToken}. */
  rejectHttpsCredential: (credentialHost: string, path: string | null, username: string) =>
    invoke<CredentialForgetResult>("reject_https_credential", {
      credentialHost,
      path,
      username,
    }),
  /** Store a provider account's transport token in the OS keychain (GL-132). The
   * token is sent once and never returned; only non-secret status comes back. */
  saveProviderToken: (
    provider: ForgeAuthProvider,
    host: string,
    accountId: string,
    login: string,
    token: string,
  ) =>
    invoke<ProviderTokenStatus>("save_provider_token", {
      provider,
      host,
      accountId,
      login,
      token,
    }),
  /** Delete a GitLane-owned provider token from the keychain — provider
   * sign-out. Idempotent; leaves the user's git credential-helper creds alone. */
  deleteProviderToken: (provider: ForgeAuthProvider, host: string, accountId: string) =>
    invoke<void>("delete_provider_token", { provider, host, accountId }),
  /** Whether a keychain token is currently stored for a provider account. */
  providerTokenStatus: (
    provider: ForgeAuthProvider,
    host: string,
    accountId: string,
    login: string,
  ) =>
    invoke<ProviderTokenStatus>("provider_token_status", {
      provider,
      host,
      accountId,
      login,
    }),
};
