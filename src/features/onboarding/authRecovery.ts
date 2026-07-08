// Pure view-model for the clone-failure recovery panel: everything the panel
// needs to offer the right fix for the attempted URL — which provider it is,
// where to create a token, the token-username convention, and the SSH key
// pages for ssh remotes. No React, no IPC.

import type { ForgeAuthProvider } from "../../lib/api";
import {
  defaultTransportUsername,
  sshKeyHelp,
  tokenCreationUrl,
  type SshKeyHelp,
} from "../../lib/forgeHelp";
import { detectRemoteUrl, forgeAuthProviderFor, providerLabel } from "../../lib/remotes";
import { cloneProviderFor } from "./flows/cloneAuth";

export interface AuthRecovery {
  /** SSH remote → key guidance instead of a token form. */
  ssh: boolean;
  /** Provider for the embedded credential form (github/other included). */
  provider: ForgeAuthProvider | "github" | "other";
  /** Provider whose Accounts connect view fixes this, or null (unknown host). */
  providerKey: "github" | ForgeAuthProvider | null;
  /** Human forge name ("GitLab", "Bitbucket", …). */
  forgeLabel: string;
  host: string | null;
  credentialHost: string | null;
  /** Repo path, the credential-scope hint for `git credential approve`. */
  path: string | null;
  /** The URL's own userinfo, if any — the value the clone form auto-seeds into
   * the username field, so the panel can tell it apart from a user's edit. */
  urlUser: string | null;
  /** Where to create a token, or null when no precise page exists. */
  tokenUrl: string | null;
  sshHelp: SshKeyHelp;
  /** Username to prefill: the recommended token's convention, else the URL's
   * own user. */
  defaultUsername: string | null;
  /** What to call the credential in copy ("a repository access token", …). */
  tokenNoun: string;
  /** Provider-specific instruction for the create-token step, or null when
   * the linked page needs no explanation. */
  tokenHint: string | null;
  /** True when the provider accepts a token with any/no username, so the
   * username is a managed detail (hidden behind "use a different username")
   * rather than a field the user must fill. Forges where the username must be
   * the real account (Gitea/Forgejo/unknown) keep it visible. */
  usernameOptional: boolean;
  /** The same repo over SSH (`git@host:path.git`) when the attempt was HTTPS —
   * the "prefer SSH?" switch. Null for SSH attempts and for Azure, whose SSH
   * URLs use a different shape than its HTTPS path. */
  sshUrl: string | null;
  /** The same repo over HTTPS when the attempt was SSH — the "no key? use a
   * token" switch. */
  httpsUrl: string | null;
}

export function buildAuthRecovery(attemptedUrl: string): AuthRecovery {
  const info = detectRemoteUrl(attemptedUrl);
  const provider = cloneProviderFor(info);
  const providerKey =
    info.provider === "github" ? "github" : forgeAuthProviderFor(info.provider);
  // Cross-transport switches. Azure is excluded from the SSH form: its scp-style
  // URL is ssh://git@ssh.dev.azure.com/v3/…, not derivable from the HTTPS path.
  const convertible = info.valid && !!info.host && !!info.path && info.provider !== "azure";
  // Bitbucket Cloud: steer to a per-repo Repository Access Token, whose scope
  // list is a short checkbox set — not the Atlassian "API token with scopes"
  // page, which lists hundreds of scopes across every Atlassian product. Only
  // when we have a workspace/repo path to point at.
  const bbRepoToken =
    provider === "bitbucket" && info.host === "bitbucket.org" && !!info.path && info.path.split("/").length === 2;

  return {
    ssh: info.ssh,
    provider,
    providerKey,
    forgeLabel: providerLabel(info.provider),
    host: info.host,
    credentialHost: info.credentialHost,
    path: info.path,
    urlUser: info.user,
    tokenUrl: bbRepoToken
      ? `https://bitbucket.org/${info.path}/admin/access-tokens`
      : info.host
        ? tokenCreationUrl(provider, info.host)
        : null,
    sshHelp: sshKeyHelp(provider, info.host ?? ""),
    // A repository access token authenticates as x-token-auth; otherwise the
    // provider's convention (or the URL's own user).
    defaultUsername: bbRepoToken ? "x-token-auth" : (info.user ?? defaultTransportUsername(provider)),
    tokenNoun: bbRepoToken ? "a repository access token" : tokenNounFor(provider),
    tokenHint: bbRepoToken
      ? "click “Create Repository Access Token”, tick Repositories: Read and Write, then copy it."
      : null,
    usernameOptional:
      provider === "github" || provider === "gitlab" || provider === "bitbucket" || provider === "azure-devops",
    sshUrl: !info.ssh && convertible ? `git@${info.host}:${info.path}.git` : null,
    httpsUrl: info.ssh && convertible ? `https://${info.credentialHost ?? info.host}/${info.path}.git` : null,
  };
}

/** How copy names the credential the provider expects. */
function tokenNounFor(provider: string): string {
  switch (provider) {
    case "bitbucket":
      return "an Atlassian API token";
    case "github":
    case "gitlab":
    case "azure-devops":
    case "gitea":
    case "forgejo":
      return "a personal access token";
    default:
      return "a token or password";
  }
}

/** Whether the failure kind + attempted URL warrant the token form (an HTTPS
 * remote); ssh remotes recover through key setup, not credentials. */
export function recoveryShowsTokenForm(recovery: AuthRecovery): boolean {
  return !recovery.ssh && !!recovery.credentialHost;
}
