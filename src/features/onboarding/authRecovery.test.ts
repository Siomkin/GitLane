import { describe, it, expect } from "vitest";
import { buildAuthRecovery } from "./authRecovery";

describe("buildAuthRecovery", () => {
  it("builds GCM/credential-helper recovery context for HTTPS remotes", () => {
    const r = buildAuthRecovery("https://bitbucket.org/darang/gitlanebucket.git");
    expect(r.ssh).toBe(false);
    expect(r.providerKey).toBe("bitbucket");
    expect(r.forgeLabel).toBe("Bitbucket");
    expect(r.credentialHost).toBe("bitbucket.org");
    expect(r.sshUrl).toBe("git@bitbucket.org:darang/gitlanebucket.git");
    expect(r.httpsUrl).toBeNull();
    expect(r.sshHelp.addUrl).toBe("https://bitbucket.org/account/settings/ssh-keys/");
  });

  it("routes SSH remotes to key guidance", () => {
    const r = buildAuthRecovery("git@github.com:octo/repo.git");
    expect(r.ssh).toBe(true);
    expect(r.providerKey).toBe("github");
    expect(r.sshHelp.addUrl).toBe("https://github.com/settings/ssh/new");
  });

  it("offers the same repo over SSH for HTTPS attempts, and vice versa", () => {
    const https = buildAuthRecovery("https://bitbucket.org/darang/gitlanebucket.git");
    expect(https.sshUrl).toBe("git@bitbucket.org:darang/gitlanebucket.git");
    expect(https.httpsUrl).toBeNull();

    const ssh = buildAuthRecovery("git@github.com:octo/repo.git");
    expect(ssh.httpsUrl).toBe("https://github.com/octo/repo.git");
    expect(ssh.sshUrl).toBeNull();
  });

  it("offers a correct HTTPS alternative for ssh:// usernames and SSH ports", () => {
    const customUser = buildAuthRecovery("ssh://alice@example.com/team/repo.git");
    expect(customUser.ssh).toBe(true);
    expect(customUser.host).toBe("example.com");
    expect(customUser.credentialHost).toBe("example.com");
    expect(customUser.httpsUrl).toBe("https://example.com/team/repo.git");

    const customPort = buildAuthRecovery("ssh://git@example.com:2222/team/repo.git");
    expect(customPort.ssh).toBe(true);
    expect(customPort.host).toBe("example.com");
    expect(customPort.credentialHost).toBe("example.com:2222");
    expect(customPort.httpsUrl).toBe("https://example.com/team/repo.git");
  });

  it("keeps IPv6 recovery URLs bracketed and uses unambiguous SSH URI syntax", () => {
    const https = buildAuthRecovery("https://[2001:db8::1]/team/repo.git");
    expect(https.host).toBe("2001:db8::1");
    expect(https.sshUrl).toBe("ssh://git@[2001:db8::1]/team/repo.git");

    const ssh = buildAuthRecovery("ssh://git@[2001:db8::1]:2222/team/repo.git");
    expect(ssh.host).toBe("2001:db8::1");
    expect(ssh.credentialHost).toBe("[2001:db8::1]:2222");
    expect(ssh.httpsUrl).toBe("https://[2001:db8::1]/team/repo.git");
  });

  it("offers no SSH switch for Azure (its SSH URLs use a different shape)", () => {
    expect(buildAuthRecovery("https://dev.azure.com/org/proj/_git/repo").sshUrl).toBeNull();
  });

  it("keeps unknown hosts recoverable but provider-less", () => {
    const r = buildAuthRecovery("https://git.internal.corp/team/repo.git");
    expect(r.providerKey).toBeNull();
    expect(r.forgeLabel).toBe("This host");
    expect(r.credentialHost).toBe("git.internal.corp");
    expect(r.sshUrl).toBe("git@git.internal.corp:team/repo.git");
  });
});
