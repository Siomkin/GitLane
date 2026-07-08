import { describe, it, expect } from "vitest";
import { buildAuthRecovery, recoveryShowsTokenForm } from "./authRecovery";

describe("buildAuthRecovery", () => {
  it("steers a Bitbucket repo to a per-repo access token (short scope list), not the scopes maze", () => {
    const r = buildAuthRecovery("https://bitbucket.org/darang/gitlanebucket.git");
    expect(r.ssh).toBe(false);
    expect(r.provider).toBe("bitbucket");
    expect(r.providerKey).toBe("bitbucket");
    expect(r.forgeLabel).toBe("Bitbucket");
    expect(r.credentialHost).toBe("bitbucket.org");
    expect(r.path).toBe("darang/gitlanebucket");
    // The repo's own access-token page, not id.atlassian.com's scopes maze.
    expect(r.tokenUrl).toBe("https://bitbucket.org/darang/gitlanebucket/admin/access-tokens");
    expect(r.tokenNoun).toBe("a repository access token");
    expect(r.tokenHint).toContain("Repositories: Read and Write");
    // Repository access tokens authenticate as x-token-auth — a managed detail.
    expect(r.defaultUsername).toBe("x-token-auth");
    expect(r.usernameOptional).toBe(true);
    expect(recoveryShowsTokenForm(r)).toBe(true);
  });

  it("keeps the repo-token username (x-token-auth) even when the URL carried a handle", () => {
    const r = buildAuthRecovery("https://SiomkinAlexander@bitbucket.org/darang/repo.git");
    // The recommended token dictates the username; the URL's handle is kept as
    // urlUser so the panel can tell it apart from a user's own edit.
    expect(r.defaultUsername).toBe("x-token-auth");
    expect(r.urlUser).toBe("SiomkinAlexander");
  });

  it("routes SSH remotes to key guidance instead of the token form", () => {
    const r = buildAuthRecovery("git@github.com:octo/repo.git");
    expect(r.ssh).toBe(true);
    expect(r.providerKey).toBe("github");
    expect(r.sshHelp.addUrl).toBe("https://github.com/settings/ssh/new");
    expect(recoveryShowsTokenForm(r)).toBe(false);
  });

  it("offers the same repo over SSH for HTTPS attempts, and vice versa", () => {
    const https = buildAuthRecovery("https://bitbucket.org/darang/gitlanebucket.git");
    expect(https.sshUrl).toBe("git@bitbucket.org:darang/gitlanebucket.git");
    expect(https.httpsUrl).toBeNull();

    const ssh = buildAuthRecovery("git@github.com:octo/repo.git");
    expect(ssh.httpsUrl).toBe("https://github.com/octo/repo.git");
    expect(ssh.sshUrl).toBeNull();
  });

  it("offers no SSH switch for Azure (its SSH URLs use a different shape)", () => {
    expect(buildAuthRecovery("https://dev.azure.com/org/proj/_git/repo").sshUrl).toBeNull();
  });

  it("keeps unknown hosts recoverable but provider-less, with the username visible", () => {
    const r = buildAuthRecovery("https://git.internal.corp/team/repo.git");
    expect(r.provider).toBe("other");
    expect(r.providerKey).toBeNull();
    expect(r.tokenUrl).toBeNull();
    expect(r.defaultUsername).toBeNull();
    expect(r.tokenNoun).toBe("a token or password");
    // No known token convention → the username is the user's to provide.
    expect(r.usernameOptional).toBe(false);
    expect(recoveryShowsTokenForm(r)).toBe(true);
  });
});
