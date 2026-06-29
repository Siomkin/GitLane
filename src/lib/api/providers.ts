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

export const providersApi = {
  /** Auth-only status for non-GitHub forge providers. No PR support implied. */
  forgeAuthStatuses: () => invoke<ForgeAuthStatus[]>("forge_auth_statuses"),
};
