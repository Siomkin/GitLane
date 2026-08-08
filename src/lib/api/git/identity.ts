// The commit identity applied to a repo's local git config, and the signing keys
// it can pick from. Mirrors `commands/identity.rs`.

import { invoke } from "@tauri-apps/api/core";
import type {
  RepoIdentity,
  RepoSigningConfig,
  SigningKey,
} from "./types";

export const identityApi = {
  /** Write a commit identity into the repo's local git config. `signing` is
   * optional; when given, its fields apply per-key (empty string unsets). */
  setRepoIdentity: (path: string, name: string, email: string, signing?: RepoSigningConfig) =>
    invoke<string>("set_repo_identity", {
      path,
      name,
      email,
      signingKey: signing?.signingKey,
      gpgFormat: signing?.gpgFormat,
      gpgSign: signing?.gpgSign,
      tagGpgSign: signing?.tagGpgSign,
    }),

  /** Signing keys the user already has (GPG secret keys + SSH public keys) for
   * the profile editor's key picker. References only — never private material. */
  listSigningKeys: () => invoke<SigningKey[]>("list_signing_keys"),

  /** Read the identity pinned in the repo's local git config (the durable,
   * build-independent source of truth). `null` = nothing pinned locally. */
  repoIdentity: (path: string) => invoke<RepoIdentity | null>("repo_identity", { path }),

  /** The default commit identity from global git config — the fallback git uses
   * when nothing is pinned locally. Powers the "Default git identity" profile
   * option. `null` when no global name/email is set. */
  defaultGitIdentity: () => invoke<RepoIdentity | null>("default_git_identity"),

  /** Remove the pinned identity from local git config (defer to global). */
  clearRepoIdentity: (path: string) => invoke<string>("clear_repo_identity", { path }),
};
