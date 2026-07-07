import { describe, expect, it } from "vitest";
import {
  azureOrg,
  credentialScopePath,
  detectRemoteUrl,
  forgeAuthProviderFor,
  isValidRemoteName,
  validateRemoteUrl,
} from "./remotes";

describe("detectRemoteUrl", () => {
  it("strips https userinfo and ports so the host matches account hosts (GL-129)", () => {
    expect(detectRemoteUrl("https://SiomkinAlexander@bitbucket.org/darang/gitlanebucket.git")).toMatchObject({
      valid: true,
      host: "bitbucket.org",
      credentialHost: "bitbucket.org",
      path: "darang/gitlanebucket",
      user: "SiomkinAlexander",
      provider: "bitbucket",
    });
    expect(detectRemoteUrl("https://github.corp.example:8443/team/repo.git")).toMatchObject({
      valid: true,
      host: "github.corp.example",
      credentialHost: "github.corp.example:8443",
    });
  });

  it("keeps credential authority exact while normalising provider host display", () => {
    expect(detectRemoteUrl("https://www.github.com/owner/repo.git")).toMatchObject({
      valid: true,
      host: "github.com",
      credentialHost: "www.github.com",
      provider: "github",
    });
    expect(detectRemoteUrl("https://alice:secret@bitbucket.org/team/repo.git")).toMatchObject({
      valid: true,
      host: "bitbucket.org",
      credentialHost: "bitbucket.org",
      user: "alice",
    });
  });

  it("parses https GitHub URLs (with and without .git)", () => {
    expect(detectRemoteUrl("https://github.com/Siomkin/GitLane.git")).toMatchObject({
      valid: true,
      host: "github.com",
      path: "Siomkin/GitLane",
      provider: "github",
    });
    expect(detectRemoteUrl("https://github.com/Siomkin/GitLane").provider).toBe("github");
  });

  it("parses scp-style SSH URLs and classifies the provider", () => {
    expect(detectRemoteUrl("git@gitlab.com:siomkin/gitlane.git")).toMatchObject({
      valid: true,
      host: "gitlab.com",
      provider: "gitlab",
    });
    expect(detectRemoteUrl("git@bitbucket.org:team/app.git").provider).toBe("bitbucket");
  });

  it("detects Azure DevOps hosts", () => {
    expect(detectRemoteUrl("https://dev.azure.com/org/proj/_git/repo").provider).toBe("azure");
  });

  it("detects Gitea and Forgejo hosts, matching the backend classify_host", () => {
    // Forgejo: Codeberg by name, or any host containing "forgejo".
    expect(detectRemoteUrl("https://codeberg.org/owner/repo.git").provider).toBe("forgejo");
    expect(detectRemoteUrl("https://forgejo.example.test/owner/repo.git").provider).toBe("forgejo");
    // Gitea: any host containing "gitea".
    expect(detectRemoteUrl("https://gitea.company.test/team/app.git").provider).toBe("gitea");
    expect(detectRemoteUrl("git@gitea.company.test:team/app.git").provider).toBe("gitea");
  });

  it("flags unrecognised but valid hosts as 'other'", () => {
    expect(detectRemoteUrl("https://git.internal.example/team/app.git").provider).toBe("other");
  });

  it("treats a host that merely contains 'github' as other (exact match, like the backend)", () => {
    expect(detectRemoteUrl("https://github.corp.example/team/app.git").provider).toBe("other");
    expect(detectRemoteUrl("https://ci.github.com/team/app.git").provider).toBe("github");
  });

  it("rejects empty and malformed URLs", () => {
    expect(detectRemoteUrl("")).toMatchObject({ empty: true, valid: false });
    expect(detectRemoteUrl("not a url")).toMatchObject({ empty: false, valid: false });
    expect(detectRemoteUrl("https://github.com/only-owner")).toMatchObject({ valid: false });
  });

  it("rejects credential protocol separators in URL fields", () => {
    expect(detectRemoteUrl("https://github.com\nhost=evil.example/owner/repo.git")).toMatchObject({
      valid: false,
    });
    expect(detectRemoteUrl("https://alice%0Ahost=evil.example@github.com/owner/repo.git")).toMatchObject({
      valid: false,
    });
    expect(detectRemoteUrl("git@gitlab.com\rhost=evil.example:owner/repo.git")).toMatchObject({
      valid: false,
    });
  });

  it("rejects malformed percent-encoded userinfo without throwing", () => {
    expect(() => detectRemoteUrl("https://100%@github.com/owner/repo.git")).not.toThrow();
    expect(detectRemoteUrl("https://100%@github.com/owner/repo.git")).toMatchObject({
      valid: false,
    });
  });
});

describe("forgeAuthProviderFor", () => {
  it("maps classified providers to their ForgeAuthProvider (normalising azure)", () => {
    expect(forgeAuthProviderFor("gitlab")).toBe("gitlab");
    expect(forgeAuthProviderFor("bitbucket")).toBe("bitbucket");
    expect(forgeAuthProviderFor("azure")).toBe("azure-devops");
    expect(forgeAuthProviderFor("gitea")).toBe("gitea");
    expect(forgeAuthProviderFor("forgejo")).toBe("forgejo");
  });

  it("returns null for GitHub (gh-owned) and unclassified hosts", () => {
    expect(forgeAuthProviderFor("github")).toBeNull();
    expect(forgeAuthProviderFor("other")).toBeNull();
  });
});

describe("azureOrg + credentialScopePath (GL-136)", () => {
  it("extracts the org from a dev.azure.com URL", () => {
    const info = detectRemoteUrl("https://dev.azure.com/contoso/proj/_git/repo");
    expect(azureOrg(info)).toBe("contoso");
    // Credentials scope by org, so multiple orgs on dev.azure.com don't collide.
    expect(credentialScopePath(info)).toBe("contoso");
  });

  it("extracts the org from a legacy {org}.visualstudio.com URL", () => {
    const info = detectRemoteUrl("https://contoso.visualstudio.com/proj/_git/repo");
    expect(info.provider).toBe("azure");
    expect(azureOrg(info)).toBe("contoso");
  });

  it("scopes non-Azure providers by host only (no path scope)", () => {
    expect(credentialScopePath(detectRemoteUrl("https://gitlab.com/group/repo.git"))).toBeNull();
    expect(azureOrg(detectRemoteUrl("https://gitlab.com/group/repo.git"))).toBeNull();
  });
});

describe("validateRemoteUrl", () => {
  it("is neutral (not savable) when empty", () => {
    expect(validateRemoteUrl("")).toMatchObject({ level: "neutral", ok: false });
  });

  it("is bad (not savable) when invalid", () => {
    expect(validateRemoteUrl("nope")).toMatchObject({ level: "bad", ok: false });
  });

  it("is ok for GitHub (PRs enabled) and savable", () => {
    const v = validateRemoteUrl("https://github.com/Siomkin/GitLane.git");
    expect(v).toMatchObject({ level: "ok", ok: true });
    expect(v.message).toMatch(/GitHub · github\.com — pull requests enabled/);
  });

  it("is ok for GitLab (PRs enabled), labelled GitLab, and savable (GL-140)", () => {
    const v = validateRemoteUrl("git@gitlab.com:siomkin/gitlane.git");
    expect(v).toMatchObject({ level: "ok", ok: true });
    expect(v.message).toMatch(/GitLab · gitlab\.com — merge requests enabled/);
  });

  it("is ok for Bitbucket (PRs enabled), labelled Bitbucket, and savable (GL-141)", () => {
    const v = validateRemoteUrl("https://alice@bitbucket.org/team/repo.git");
    expect(v).toMatchObject({ level: "ok", ok: true });
    expect(v.message).toMatch(/Bitbucket · bitbucket\.org — pull requests enabled/);
  });

  it("warns for a valid non-PR forge (Azure DevOps) but still allows saving", () => {
    const v = validateRemoteUrl("https://dev.azure.com/org/proj/_git/repo");
    expect(v).toMatchObject({ level: "warn", ok: true });
    expect(v.message).toMatch(/pull requests unavailable/);
  });
});

describe("isValidRemoteName", () => {
  it("accepts ordinary remote names", () => {
    for (const ok of ["origin", "upstream", "fork-2", "my.remote", "a_b"]) {
      expect(isValidRemoteName(ok), ok).toBe(true);
    }
  });

  it("rejects empty, spaced, and special-character names", () => {
    for (const bad of ["", "  ", "my remote", "-origin", ".hidden", "a/b", "remote!", "a$b"]) {
      expect(isValidRemoteName(bad), bad).toBe(false);
    }
  });
});
