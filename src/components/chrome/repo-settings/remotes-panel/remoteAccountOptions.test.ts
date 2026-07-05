import { describe, expect, it } from "vitest";

import type { ForgeAuthStatus } from "../../../../lib/api";
import { remoteAccountPickerModel, type PickerAccount } from "./remoteAccountOptions";

const acct = (host: string, login: string, healthy = true): PickerAccount => ({
  id: `gh:${host}:${login}`,
  host,
  login,
  healthy,
});

const remote = (url: string) => ({ fetchUrl: url, pushUrl: url });

describe("remoteAccountPickerModel", () => {
  const github = acct("github.com", "alice");
  const ghe = acct("ghe.corp", "worker");

  it("offers exactly the accounts whose host matches the remote", () => {
    const model = remoteAccountPickerModel(remote("https://github.com/o/r.git"), [github, ghe]);
    expect(model.host).toBe("github.com");
    expect(model.matching).toEqual([github]);
    expect(model.note).toMatch(/Use a connected GitHub account/);
  });

  it("matches on the push URL when it differs from fetch", () => {
    const model = remoteAccountPickerModel(
      { fetchUrl: "https://github.com/o/r.git", pushUrl: "https://ghe.corp/o/r.git" },
      [github, ghe],
    );
    expect(model.host).toBe("ghe.corp");
    expect(model.matching).toEqual([ghe]);
  });

  it("does not match a custom-port remote to a portless account host", () => {
    const model = remoteAccountPickerModel(remote("https://worker@ghe.corp:8443/o/r.git"), [
      ghe,
      acct("ghe.corp:8443", "worker"),
    ]);
    expect(model.credentialHost).toBe("ghe.corp:8443");
    expect(model.matching).toEqual([acct("ghe.corp:8443", "worker")]);
  });

  it("points a GitHub host with no matching account at Settings → Accounts", () => {
    const model = remoteAccountPickerModel(remote("https://github.com/o/r.git"), [ghe]);
    expect(model.matching).toEqual([]);
    expect(model.note).toMatch(/Use a connected GitHub account/);
  });

  it("explains that non-GitHub forges use system credentials, SSH-aware", () => {
    const model = remoteAccountPickerModel(
      remote("https://alice@bitbucket.org/team/repo.git"),
      [github],
    );
    expect(model.matching).toEqual([]);
    expect(model.username).toBe("alice");
    expect(model.note).toMatch(/Bitbucket transport auth uses an HTTPS username/);
    expect(model.note).toMatch(/keychain \/ credential helper/);

    // An SSH remote is its own world: the key IS the account — no forge copy.
    const lab = remoteAccountPickerModel(remote("git@gitlab.com:group/repo.git"), [github]);
    expect(lab.note).toMatch(/SSH remote — the account is selected by your SSH key/);
    expect(lab.matching).toEqual([]);
  });

  it("acknowledges a CLI sign-in the Accounts page detected instead of denying it", () => {
    // glab says the user IS signed in — the note must agree with the Accounts
    // page while still explaining the git transport credential path.
    const glabStatus: ForgeAuthStatus = {
      provider: "gitlab",
      forge: "GitLab",
      cli: "glab",
      authMethod: "GitLab CLI",
      available: true,
      authenticated: true,
      loginCommand: "glab auth login",
      docsUrl: "x",
      notes: "y",
      account: { username: "siomkin" },
    };
    const model = remoteAccountPickerModel(
      remote("https://gitlab.com/siomkin/gitlanelab.git"),
      [github],
      [glabStatus],
    );
    expect(model.note).toMatch(/Signed in as @siomkin via glab/);
    expect(model.note).toMatch(/URL username/);
    expect(model.note).toMatch(/keychain \/ credential helper/);
  });

  it("falls back to a plain system-credentials note for unknown or unparsable hosts", () => {
    expect(remoteAccountPickerModel(remote("https://git.corp.dev/o/r.git"), [github]).note).toMatch(
      /system git credentials/,
    );
    expect(remoteAccountPickerModel(remote("/local/path.git"), [github]).note).toMatch(
      /SSH key|system git credentials/,
    );
  });
});
