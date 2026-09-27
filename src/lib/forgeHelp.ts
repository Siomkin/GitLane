// Pure, provider-keyed help facts for forge authentication: default hosts,
// where to create a token, where to add an SSH key, and each provider's
// token-username convention. Shared by the Accounts panel's connect methods and
// the onboarding clone/recovery surfaces — no React, no IPC.

import type { ForgeAuthProvider } from "./api/providers";
import { CURSOR_ORIGIN_HOST, ForgeKind, type ForgeCapabilities, type RepoForge } from "./api/git/types/repo";

/** How each forge names itself and its review request — the words half of the
 * one per-forge presentation table (`components/ui/forges.tsx` adds the icon).
 * Capabilities are not here: those come from the backend (`RepoForge`). */
export const FORGE_NAMES: Record<ForgeKind, { label: string; noun: "pull request" | "merge request" }> = {
  [ForgeKind.GitHub]: { label: "GitHub", noun: "pull request" },
  [ForgeKind.GitLab]: { label: "GitLab", noun: "merge request" },
  [ForgeKind.Bitbucket]: { label: "Bitbucket", noun: "pull request" },
  [ForgeKind.AzureDevOps]: { label: "Azure DevOps", noun: "pull request" },
  [ForgeKind.Gitea]: { label: "Gitea", noun: "pull request" },
  [ForgeKind.Forgejo]: { label: "Forgejo", noun: "pull request" },
  [ForgeKind.CursorOrigin]: { label: "Cursor Origin", noun: "pull request" },
};

export type PullRequestProvider = "github" | "gitlab" | "bitbucket" | typeof ForgeKind.CursorOrigin;

/** Non-GitHub forge providers the backend can probe or remember credentials for. */
export const FORGE_AUTH_PROVIDERS = new Set<ForgeAuthProvider>([
  "gitlab",
  "bitbucket",
  "azure-devops",
  "gitea",
  "forgejo",
  ForgeKind.CursorOrigin,
]);

/** Providers where GitLane can ask a CLI/API for the signed-in account identity.
 * Keep in sync with the `account()` whoami dispatch in `src-tauri/src/auth_providers.rs`. */
export const FORGE_WHOAMI_PROVIDERS = new Set<ForgeAuthProvider>(["gitlab", "azure-devops", ForgeKind.CursorOrigin]);

/** Providers where GitLane's backend supports a first-party CLI sign-out command. */
export const FORGE_CLI_SIGN_OUT_PROVIDERS = new Set<ForgeAuthProvider>(["gitlab", "azure-devops", ForgeKind.CursorOrigin]);

/** Providers whose pull/merge-request workflows GitLane can drive in-app —
 * for surfaces that know only a provider word (a remote URL, an account row).
 * An open repository gates on its `RepoForge.capabilities` instead, which the
 * backend adapters declare (see {@link prCapabilities}). */
export const PULL_REQUEST_PROVIDERS = new Set<PullRequestProvider>(["github", "gitlab", "bitbucket", ForgeKind.CursorOrigin]);

/** The capability set assumed while the open repo's forge is still being
 * detected (a null `RepoForge`): the gh default the PR surface renders under,
 * so a slow detect never flickers an action away. */
const PENDING_FORGE_CAPABILITIES: ForgeCapabilities = {
  create: true,
  mergeMethods: ["merge", "squash", "rebase"],
  stateActions: ["close", "reopen", "ready"],
  deleteBranch: true,
  stacks: true,
};

/** What the open repository's forge can do with pull requests: the backend's
 * declared record, everything while detection is pending, or `null` when the
 * forge has no pull requests in GitLane (no remote, or a non-PR forge). */
export function prCapabilities(forge: RepoForge | null | undefined): ForgeCapabilities | null {
  return forge == null ? PENDING_FORGE_CAPABILITIES : (forge.capabilities ?? null);
}

/** Whether a pull request can be opened on the open repository's forge. */
export function canCreatePullRequests(forge: RepoForge | null | undefined): boolean {
  return prCapabilities(forge)?.create === true;
}

/** PR/MR providers whose connected forge auth row is itself enough for the PR
 * surface. Bitbucket has no CLI-backed API auth, so it still needs a GitLane
 * keychain token even though git transport credentials can be saved. */
export const FORGE_AUTH_PULL_REQUEST_PROVIDERS = new Set<ForgeAuthProvider>(["gitlab", ForgeKind.CursorOrigin]);

/** Non-GitHub providers whose tokens GitLane can store in its own keychain and
 * feed back to git through the credential bridge. */
export const PROVIDER_TOKEN_AUTH_PROVIDERS = new Set<ForgeAuthProvider>(["gitlab", "bitbucket"]);

/** Providers where a pasted HTTPS credential should default to also being saved
 * as a GitLane-owned PR/MR token. GitLab usually has `glab` as its primary PR
 * path; Bitbucket has no first-party CLI, so keychain-backed PR auth is the
 * useful default there. */
export const DEFAULT_PROVIDER_TOKEN_PR_SAVE_PROVIDERS = new Set<ForgeAuthProvider>(["bitbucket"]);

export function supportsPullRequests(provider: string | null | undefined): provider is PullRequestProvider {
  return provider ? PULL_REQUEST_PROVIDERS.has(provider as PullRequestProvider) : false;
}

export function supportsPullRequestsViaForgeAuth(provider: string | null | undefined): provider is ForgeAuthProvider {
  return provider ? FORGE_AUTH_PULL_REQUEST_PROVIDERS.has(provider as ForgeAuthProvider) : false;
}

export function pullRequestLabel(provider: string | null | undefined): string {
  const noun = FORGE_NAMES[provider as ForgeKind]?.noun ?? "pull request";
  return `${noun[0].toUpperCase()}${noun.slice(1)}s`;
}

export function isForgeAuthProvider(provider: string | null | undefined): provider is ForgeAuthProvider {
  return provider ? FORGE_AUTH_PROVIDERS.has(provider as ForgeAuthProvider) : false;
}

export function supportsForgeWhoami(provider: string | null | undefined): provider is ForgeAuthProvider {
  return provider ? FORGE_WHOAMI_PROVIDERS.has(provider as ForgeAuthProvider) : false;
}

export function supportsForgeCliSignOut(provider: string | null | undefined): provider is ForgeAuthProvider {
  return provider ? FORGE_CLI_SIGN_OUT_PROVIDERS.has(provider as ForgeAuthProvider) : false;
}

export function supportsProviderTokenAuth(provider: string | null | undefined): provider is ForgeAuthProvider {
  return provider ? PROVIDER_TOKEN_AUTH_PROVIDERS.has(provider as ForgeAuthProvider) : false;
}

export function defaultsToProviderTokenForPullRequests(
  provider: string | null | undefined,
): provider is ForgeAuthProvider {
  return provider ? DEFAULT_PROVIDER_TOKEN_PR_SAVE_PROVIDERS.has(provider as ForgeAuthProvider) : false;
}

export const DEFAULT_CREDENTIAL_HOST: Record<string, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
  "azure-devops": "dev.azure.com",
  [ForgeKind.CursorOrigin]: CURSOR_ORIGIN_HOST,
};

/** Where to create a personal access / API token for `provider`. `status.docsUrl`
 * points at the *CLI* repo (e.g. glab), not the token page, so the token method
 * needs its own link. Host-parameterised for GitLab (self-managed). Returns
 * `null` when we can't build a precise URL (e.g. Gitea/Forgejo, whose host isn't
 * known here) — the caller falls back to the provider's docs. */
export function tokenCreationUrl(provider: string, host: string): string | null {
  switch (provider) {
    case "gitlab":
      // Classic PAT form: GitLab's documented prefill reads `name` + `scopes`
      // (comma-separated) to land on the form with exactly the git-over-HTTPS
      // scopes pre-checked. Fine-grained tokens use a resource/permission model
      // with no scope prefill, so the classic form is the one-click path.
      return `https://${host}/-/user_settings/personal_access_tokens?name=GitLane&scopes=read_repository,write_repository`;
    case "bitbucket":
      // Atlassian API tokens — app passwords are deprecated.
      return "https://id.atlassian.com/manage-profile/security/api-tokens";
    case "azure-devops":
      return "https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate";
    default:
      return null;
  }
}

/** The HTTPS username convention for a token created via `tokenCreationUrl` —
 * the value git sends alongside the token, when a static sentinel exists.
 * Bitbucket's Atlassian API tokens work with the user's own username OR the
 * static `x-bitbucket-api-token-auth`; we prefill the static one because it
 * needs no knowledge of who the user is (Atlassian recommends it for apps and
 * integrations). Repository/workspace access tokens and OAuth use
 * `x-token-auth` instead. GitLab and the rest accept the user's handle, so
 * there is nothing to prefill — `null`. */
export function defaultTransportUsername(provider: string): string | null {
  return provider === "bitbucket" ? "x-bitbucket-api-token-auth" : null;
}

export interface SshKeyHelp {
  /** The provider's "add an SSH key" page, host-aware where possible; `null`
   * when the host isn't known here (Gitea/Forgejo) or the page is org-scoped
   * (Azure DevOps). */
  addUrl: string | null;
  /** How to generate + add an SSH key, or `null` when there's no stable doc. */
  docsUrl: string | null;
}

/** Where to add an SSH key + how-to, per provider. SSH is a key-based transport
 * GitLane doesn't store — an `ssh://` remote authenticates via the key +
 * ssh-agent — so this is purely a link-out to set the key up on the forge. */
export function sshKeyHelp(provider: string, host: string): SshKeyHelp {
  switch (provider) {
    case "github":
      return {
        addUrl: "https://github.com/settings/ssh/new",
        docsUrl: "https://docs.github.com/authentication/connecting-to-github-with-ssh",
      };
    case "gitlab":
      return { addUrl: `https://${host}/-/user_settings/ssh_keys`, docsUrl: "https://docs.gitlab.com/user/ssh/" };
    case "bitbucket":
      return {
        addUrl: "https://bitbucket.org/account/settings/ssh-keys/",
        docsUrl: "https://support.atlassian.com/bitbucket-cloud/docs/set-up-an-ssh-key/",
      };
    case "azure-devops":
      return {
        addUrl: null,
        docsUrl: "https://learn.microsoft.com/azure/devops/repos/git/use-ssh-keys-to-authenticate",
      };
    default:
      return { addUrl: null, docsUrl: null };
  }
}
