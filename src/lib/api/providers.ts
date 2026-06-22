import { invoke } from "@tauri-apps/api/core";

export type ForgeAuthProvider =
  | "gitlab"
  | "bitbucket"
  | "azure-devops"
  | "gitea"
  | "forgejo";

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
}

export const providersApi = {
  /** Auth-only status for non-GitHub forge providers. No PR support implied. */
  forgeAuthStatuses: () => invoke<ForgeAuthStatus[]>("forge_auth_statuses"),
};
