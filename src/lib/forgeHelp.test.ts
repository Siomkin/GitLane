import { describe, it, expect } from "vitest";
import {
  DEFAULT_CREDENTIAL_HOST,
  defaultsToProviderTokenForPullRequests,
  defaultTransportUsername,
  isForgeAuthProvider,
  pullRequestLabel,
  sshKeyHelp,
  supportsEditableOauthHost,
  supportsForgeCliSignOut,
  supportsForgeWhoami,
  supportsProviderTokenAuth,
  supportsCreatingPullRequests,
  supportsPullRequests,
  supportsPullRequestsViaForgeAuth,
  tokenCreationUrl,
} from "./forgeHelp";

describe("tokenCreationUrl", () => {
  it("is host-parameterised for GitLab (self-managed)", () => {
    expect(tokenCreationUrl("gitlab", "git.corp.io")).toContain("https://git.corp.io/");
    expect(tokenCreationUrl("gitlab", "gitlab.com")).toContain("personal_access_tokens");
  });

  it("points Bitbucket at Atlassian API tokens", () => {
    expect(tokenCreationUrl("bitbucket", "bitbucket.org")).toBe(
      "https://id.atlassian.com/manage-profile/security/api-tokens",
    );
  });

  it("returns null when no precise URL exists", () => {
    expect(tokenCreationUrl("gitea", "try.gitea.io")).toBeNull();
  });
});

describe("defaultTransportUsername", () => {
  it("matches the token type the creation link issues (Bitbucket API tokens)", () => {
    expect(defaultTransportUsername("bitbucket")).toBe("x-bitbucket-api-token-auth");
  });

  it("has nothing to prefill where the user's own handle is expected", () => {
    expect(defaultTransportUsername("gitlab")).toBeNull();
    expect(defaultTransportUsername("github")).toBeNull();
    expect(defaultTransportUsername("gitea")).toBeNull();
  });
});

describe("sshKeyHelp", () => {
  it("links the add-key page per provider, host-aware for GitLab", () => {
    expect(sshKeyHelp("github", "github.com").addUrl).toBe("https://github.com/settings/ssh/new");
    expect(sshKeyHelp("gitlab", "git.corp.io").addUrl).toBe("https://git.corp.io/-/user_settings/ssh_keys");
    expect(sshKeyHelp("bitbucket", "bitbucket.org").addUrl).toContain("bitbucket.org/account/settings/ssh-keys");
  });

  it("degrades to docs-only or nothing where no stable page exists", () => {
    expect(sshKeyHelp("azure-devops", "dev.azure.com").addUrl).toBeNull();
    expect(sshKeyHelp("azure-devops", "dev.azure.com").docsUrl).not.toBeNull();
    expect(sshKeyHelp("forgejo", "codeberg.org")).toEqual({ addUrl: null, docsUrl: null });
  });
});

describe("DEFAULT_CREDENTIAL_HOST", () => {
  it("covers the hosted forges GitLane offers token entry for", () => {
    expect(DEFAULT_CREDENTIAL_HOST.github).toBe("github.com");
    expect(DEFAULT_CREDENTIAL_HOST.gitlab).toBe("gitlab.com");
    expect(DEFAULT_CREDENTIAL_HOST.bitbucket).toBe("bitbucket.org");
    expect(DEFAULT_CREDENTIAL_HOST["azure-devops"]).toBe("dev.azure.com");
  });
});

describe("provider capabilities", () => {
  it("centralizes the non-GitHub forge provider set", () => {
    expect(isForgeAuthProvider("gitlab")).toBe(true);
    expect(isForgeAuthProvider("bitbucket")).toBe(true);
    expect(isForgeAuthProvider("azure-devops")).toBe(true);
    expect(isForgeAuthProvider("gitea")).toBe(true);
    expect(isForgeAuthProvider("forgejo")).toBe(true);
    expect(isForgeAuthProvider("github")).toBe(false);
  });

  it("centralizes which providers support PR workflows", () => {
    expect(supportsPullRequests("github")).toBe(true);
    expect(supportsPullRequests("gitlab")).toBe(true);
    expect(supportsPullRequests("bitbucket")).toBe(true);
    expect(supportsPullRequests("cursor-origin")).toBe(true);
    expect(supportsPullRequests("azure-devops")).toBe(false);
    expect(supportsCreatingPullRequests("github")).toBe(true);
    expect(supportsCreatingPullRequests("cursor-origin")).toBe(false);
    expect(supportsCreatingPullRequests("azure-devops")).toBe(false);
  });

  it("centralizes provider-specific PR wording and auth readiness", () => {
    expect(pullRequestLabel("gitlab")).toBe("Merge requests");
    expect(pullRequestLabel("bitbucket")).toBe("Pull requests");

    expect(supportsPullRequestsViaForgeAuth("gitlab")).toBe(true);
    expect(supportsPullRequestsViaForgeAuth("bitbucket")).toBe(false);
    expect(supportsPullRequestsViaForgeAuth("azure-devops")).toBe(false);
  });

  it("centralizes providers with account whoami and CLI sign-out support", () => {
    expect(supportsForgeWhoami("gitlab")).toBe(true);
    expect(supportsForgeWhoami("azure-devops")).toBe(true);
    expect(supportsForgeWhoami("bitbucket")).toBe(false);

    expect(supportsForgeCliSignOut("gitlab")).toBe(true);
    expect(supportsForgeCliSignOut("azure-devops")).toBe(true);
    expect(supportsForgeCliSignOut("bitbucket")).toBe(false);
  });

  it("centralizes which non-GitHub providers can use GitLane keychain tokens", () => {
    expect(supportsProviderTokenAuth("gitlab")).toBe(true);
    expect(supportsProviderTokenAuth("bitbucket")).toBe(true);
    expect(supportsProviderTokenAuth("github")).toBe(false);
    expect(supportsProviderTokenAuth("azure-devops")).toBe(false);
  });

  it("centralizes which provider-token flows default to PR storage", () => {
    expect(defaultsToProviderTokenForPullRequests("bitbucket")).toBe(true);
    expect(defaultsToProviderTokenForPullRequests("gitlab")).toBe(false);
    expect(defaultsToProviderTokenForPullRequests("github")).toBe(false);
  });

  it("centralizes providers with editable OAuth hosts", () => {
    expect(supportsEditableOauthHost("gitlab")).toBe(true);
    expect(supportsEditableOauthHost("bitbucket")).toBe(false);
    expect(supportsEditableOauthHost("azure-devops")).toBe(false);
  });
});
