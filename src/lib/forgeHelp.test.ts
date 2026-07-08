import { describe, it, expect } from "vitest";
import { DEFAULT_CREDENTIAL_HOST, defaultTransportUsername, sshKeyHelp, tokenCreationUrl } from "./forgeHelp";

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
