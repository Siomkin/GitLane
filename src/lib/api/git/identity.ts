// The commit identity applied to a repo's local git config, and the signing keys
// it can pick from. Mirrors `commands/identity.rs`.

import { invoke } from "@/lib/api/invoke";
import { repoIdentitySchema, signingKeySchema } from "@/lib/api/schemas";
import { parse } from "@/lib/api/validate";
import { z } from "zod";
import type {
  RepoIdentity,
  RepoSigningConfig,
  SigningKey,
} from "./types";

export const identityApi = {
  /** Write a commit identity into the repo's local git config. `signing` is
   * optional; when given, its fields apply per-key (empty string unsets). */
  setRepoIdentity: async (
    path: string,
    name: string,
    email: string,
    signing?: RepoSigningConfig,
  ) =>
    parse(
      z.string(),
      await invoke("set_repo_identity", {
        path,
        name,
        email,
        signingKey: signing?.signingKey,
        gpgFormat: signing?.gpgFormat,
        gpgSign: signing?.gpgSign,
        tagGpgSign: signing?.tagGpgSign,
      }),
      "set_repo_identity",
    ),

  /** Signing keys the user already has (GPG secret keys + SSH public keys) for
   * the profile editor's key picker. References only — never private material. */
  listSigningKeys: async (): Promise<SigningKey[]> =>
    parse(z.array(signingKeySchema), await invoke("list_signing_keys"), "list_signing_keys"),

  /** Read the identity pinned in the repo's local git config (the durable,
   * build-independent source of truth). `null` = nothing pinned locally. */
  repoIdentity: async (path: string): Promise<RepoIdentity | null> =>
    parse(repoIdentitySchema.nullable(), await invoke("repo_identity", { path }), "repo_identity"),

  /** The default commit identity from global git config — the fallback git uses
   * when nothing is pinned locally. Powers the "Default git identity" profile
   * option. `null` when no global name/email is set. */
  defaultGitIdentity: async (): Promise<RepoIdentity | null> =>
    parse(
      repoIdentitySchema.nullable(),
      await invoke("default_git_identity"),
      "default_git_identity",
    ),

  /** Remove the pinned identity from local git config (defer to global). */
  clearRepoIdentity: async (path: string) =>
    parse(z.string(), await invoke("clear_repo_identity", { path }), "clear_repo_identity"),
};
