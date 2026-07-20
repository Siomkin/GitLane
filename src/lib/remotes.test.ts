import { describe, expect, it } from "vitest";
import {
  azureOrg,
  credentialScopePath,
  detectRemoteUrl,
  forgeAuthProviderFor,
  httpUrlHasPassword,
  isSecretlikeUsername,
  isValidRemoteName,
  providerForHost,
  transportProviderForRemoteProvider,
  validateRemoteUrl,
} from "./remotes";

describe("providerForHost", () => {
  // Mirrors the Rust `classification_requires_a_whole_host_label` test — these
  // two implementations must agree or the UI names one forge while the backend
  // dispatches another.
  it("classifies by whole host label, not substring", () => {
    for (const host of ["notgitlab.com", "evil-bitbucket.attacker.test", "mygitea.example.com", "gitlabber.io"]) {
      expect(providerForHost(host), host).toBe("other");
    }
  });

  it("still recognises real and self-hosted forge hosts", () => {
    expect(providerForHost("github.com")).toBe("github");
    expect(providerForHost("gitlab.com")).toBe("gitlab");
    expect(providerForHost("gitlab.example.com")).toBe("gitlab");
    expect(providerForHost("gitlab-ee.corp.test")).toBe("gitlab");
    expect(providerForHost("bitbucket.org")).toBe("bitbucket");
    expect(providerForHost("dev.azure.com")).toBe("azure");
    expect(providerForHost("codeberg.org")).toBe("forgejo");
    expect(providerForHost("gitea.company.test")).toBe("gitea");
  });
});

describe("httpUrlHasPassword", () => {
  it("rejects an explicit password half on every persisted scheme", () => {
    // git writes ssh:// and git:// into .git/config verbatim, so a password is
    // just as exposed there as over https.
    for (const url of [
      "https://alice:hunter2@example.com/team/repo.git",
      "http://alice:hunter2@example.com/team/repo.git",
      "ssh://alice:hunter2@example.com/team/repo.git",
      "git://alice:hunter2@example.com/team/repo.git",
    ]) {
      expect(httpUrlHasPassword(url), url).toBe(true);
      expect(detectRemoteUrl(url).valid, url).toBe(false);
    }
  });

  it("rejects a token parked in the username slot", () => {
    // GitHub and GitLab both accept https://<token>@host — the "username" is
    // the credential, and it would otherwise reach .git/config and clone argv.
    for (const url of [
      "https://ghp_AbCdEf0123456789@github.com/o/r.git",
      "https://github_pat_11ABC0000_aaaa@github.com/o/r.git",
      "https://glpat-XxYyZz123456@gitlab.com/g/r.git",
    ]) {
      expect(httpUrlHasPassword(url), url).toBe(true);
      expect(detectRemoteUrl(url).valid, url).toBe(false);
    }
  });

  it("rejects a percent-encoded token username", () => {
    // git percent-decodes userinfo, so ghp%5F… authenticates as ghp_….
    expect(isSecretlikeUsername("ghp%5FAbCdEf0123456789")).toBe(true);
    expect(httpUrlHasPassword("https://ghp%5FAbCdEf0123456789@github.com/o/r.git")).toBe(true);
    // A malformed escape must not throw — decodeURIComponent rejects a lone %.
    expect(isSecretlikeUsername("alice%")).toBe(false);
    expect(isSecretlikeUsername("alice%zz")).toBe(false);
  });

  it("keeps username-only account selectors valid", () => {
    // Usernames are how per-remote auth picks an account; the OAuth sentinels
    // are not secrets. Over-redacting here would break a real feature.
    for (const user of ["alice", "oauth2", "x-token-auth", "git"]) {
      expect(isSecretlikeUsername(user), user).toBe(false);
      expect(httpUrlHasPassword(`https://${user}@github.com/o/r.git`), user).toBe(false);
    }
    expect(detectRemoteUrl("https://alice@github.com/o/r.git")).toMatchObject({
      valid: true,
      user: "alice",
    });
  });
});

describe("detectRemoteUrl", () => {
  it("strips https userinfo and ports so the host matches account hosts (GL-129)", () => {
    expect(detectRemoteUrl("https://test-user@bitbucket.org/darang/gitlanebucket.git")).toMatchObject({
      valid: true,
      host: "bitbucket.org",
      credentialHost: "bitbucket.org",
      credentialPath: "darang/gitlanebucket.git",
      path: "darang/gitlanebucket",
      user: "test-user",
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
    expect(detectRemoteUrl("https://alice@bitbucket.org/team/repo.git")).toMatchObject({
      valid: true,
      host: "bitbucket.org",
      credentialHost: "bitbucket.org",
      user: "alice",
    });
  });

  it("rejects password-bearing HTTP(S) userinfo but keeps username-only selectors", () => {
    expect(detectRemoteUrl("https://alice@bitbucket.org/team/repo.git")).toMatchObject({
      valid: true,
      user: "alice",
    });
    for (const url of [
      "https://alice:secret@bitbucket.org/team/repo.git",
      "http://alice:@git.example.test/team/repo.git",
      "https://token:p@ss@git.example.test/team/repo.git",
    ]) {
      expect(detectRemoteUrl(url).valid, url).toBe(false);
      expect(validateRemoteUrl(url)).toMatchObject({ level: "bad", ok: false });
    }
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

  it("keeps Git's exact decoded credential path separate from the normalized repo path", () => {
    expect(
      detectRemoteUrl("https://dev.azure.com/contoso/Project%20One/_git/repo.git/"),
    ).toMatchObject({
      valid: true,
      path: "contoso/Project%20One/_git/repo",
      credentialPath: "contoso/Project One/_git/repo.git",
    });
    // Git decodes URL bytes once: an escaped percent remains for the helper.
    expect(
      detectRemoteUrl("https://dev.azure.com/contoso/Project%2520One/_git/repo.git")
        .credentialPath,
    ).toBe("contoso/Project%20One/_git/repo.git");
    // Malformed escapes remain literal, matching Git's credential parser.
    expect(
      detectRemoteUrl("https://dev.azure.com/contoso/Project%ZZ/_git/repo.git").credentialPath,
    ).toBe("contoso/Project%ZZ/_git/repo.git");
  });

  it("parses scp-style SSH URLs and classifies the provider", () => {
    expect(detectRemoteUrl("git@gitlab.com:siomkin/gitlane.git")).toMatchObject({
      valid: true,
      host: "gitlab.com",
      credentialHost: "gitlab.com",
      path: "siomkin/gitlane",
      provider: "gitlab",
    });
    expect(detectRemoteUrl("git@bitbucket.org:team/app.git").provider).toBe("bitbucket");
  });

  it("parses ssh:// usernames and ports without folding the port into the repo path", () => {
    expect(detectRemoteUrl("ssh://alice@example.com/team/repo.git")).toMatchObject({
      valid: true,
      ssh: true,
      host: "example.com",
      credentialHost: "example.com",
      path: "team/repo",
      user: null,
    });
    expect(detectRemoteUrl("ssh://git@gitlab.com:2222/team/repo.git")).toMatchObject({
      valid: true,
      ssh: true,
      host: "gitlab.com",
      credentialHost: "gitlab.com:2222",
      path: "team/repo",
      provider: "gitlab",
    });
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
    expect(detectRemoteUrl("https://dev.azure.com/org/project%0Aname/_git/repo.git")).toMatchObject({
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

describe("transportProviderForRemoteProvider", () => {
  it("normalizes remote classifications to git transport provider tags", () => {
    expect(transportProviderForRemoteProvider("github")).toBe("github");
    expect(transportProviderForRemoteProvider("gitlab")).toBe("gitlab");
    expect(transportProviderForRemoteProvider("bitbucket")).toBe("bitbucket");
    expect(transportProviderForRemoteProvider("azure")).toBe("azure-devops");
    expect(transportProviderForRemoteProvider("gitea")).toBe("gitea");
    expect(transportProviderForRemoteProvider("forgejo")).toBe("forgejo");
    expect(transportProviderForRemoteProvider("other")).toBe("other");
  });
});

describe("azureOrg + credentialScopePath (GL-136)", () => {
  it("extracts the org while scoping helpers by Git's exact full path", () => {
    const info = detectRemoteUrl("https://dev.azure.com/contoso/My%20Project/_git/repo.git");
    expect(azureOrg(info)).toBe("contoso");
    expect(credentialScopePath(info)).toBe("contoso/My Project/_git/repo.git");
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
