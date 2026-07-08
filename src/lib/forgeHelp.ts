// Pure, provider-keyed help facts for forge authentication: default hosts,
// where to create a token, where to add an SSH key, and each provider's
// token-username convention. Shared by the Accounts panel's connect methods and
// the onboarding clone/recovery surfaces — no React, no IPC.

export const DEFAULT_CREDENTIAL_HOST: Record<string, string> = {
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
  "azure-devops": "dev.azure.com",
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
