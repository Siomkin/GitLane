import { describe, expect, it } from "vitest";

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
    expect(model.note).toBeNull();
  });

  it("matches on the push URL when it differs from fetch", () => {
    const model = remoteAccountPickerModel(
      { fetchUrl: "https://github.com/o/r.git", pushUrl: "git@ghe.corp:o/r.git" },
      [github, ghe],
    );
    expect(model.host).toBe("ghe.corp");
    expect(model.matching).toEqual([ghe]);
  });

  it("points a GitHub host with no matching account at Settings → Accounts", () => {
    const model = remoteAccountPickerModel(remote("https://github.com/o/r.git"), [ghe]);
    expect(model.matching).toEqual([]);
    expect(model.note).toMatch(/No connected account for github.com/);
  });

  it("explains that non-GitHub forges use system credentials (no in-app sign-in yet)", () => {
    const model = remoteAccountPickerModel(
      remote("https://alice@bitbucket.org/team/repo.git"),
      [github],
    );
    expect(model.matching).toEqual([]);
    expect(model.note).toMatch(/Bitbucket sign-in isn't available in GitLane yet/);

    const lab = remoteAccountPickerModel(remote("git@gitlab.com:group/repo.git"), [github]);
    expect(lab.note).toMatch(/GitLab sign-in isn't available in GitLane yet/);
  });

  it("falls back to a plain system-credentials note for unknown or unparsable hosts", () => {
    expect(remoteAccountPickerModel(remote("https://git.corp.dev/o/r.git"), [github]).note).toMatch(
      /system git credentials/,
    );
    expect(remoteAccountPickerModel(remote("/local/path.git"), [github]).note).toMatch(
      /system git credentials/,
    );
  });
});
