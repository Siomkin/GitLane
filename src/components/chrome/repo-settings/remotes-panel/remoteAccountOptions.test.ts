import { describe, expect, it } from "vitest";

import type { ForgeAuthStatus } from "@/lib/api";
import { providerTokenKey, TOKEN_ACCOUNT_PREFIX, type StoredProviderToken } from "@/store/accounts";
import { remoteAccountPickerModel, SYSTEM_ACCOUNT, type PickerAccount } from "./remoteAccountOptions";

const acct = (host: string, login: string, healthy = true): PickerAccount => ({
  id: `gh:${host}:${login}`,
  host,
  login,
  healthy,
});

const remote = (url: string) => ({ fetchUrl: url, pushUrl: url });

describe("remoteAccountPickerModel — keychain tokens", () => {
  const gh = acct("github.com", "Octocat");
  const tok = (login: string, over: Partial<StoredProviderToken> = {}): StoredProviderToken => ({
    provider: "github",
    credentialHost: "github.com",
    accountId: login,
    login,
    savedAt: 1,
    ...over,
  });
  const tokens = (...list: StoredProviderToken[]) =>
    Object.fromEntries(list.map((t) => [providerTokenKey(t.credentialHost, t.login), t]));
  const valueOf = (t: StoredProviderToken) =>
    `${TOKEN_ACCOUNT_PREFIX}${providerTokenKey(t.credentialHost, t.login)}`;
  const model = (url: string, list: StoredProviderToken[], accounts = [gh]) =>
    remoteAccountPickerModel(remote(url), accounts, [], tokens(...list));

  const shared = tok("octocat");

  it("lists a gh account and a same-login token separately, labelled by source", () => {
    expect(model("https://Octocat@github.com/o/r.git", [shared]).options).toEqual([
      { value: gh.id, label: "@Octocat · GitHub CLI" },
      { value: valueOf(shared), label: "@octocat · Keychain token" },
    ]);
  });

  it("leaves out tokens for another host or another forge", () => {
    const options = model("https://github.com/o/r.git", [
      tok("worker", { credentialHost: "ghe.corp" }),
      tok("ada", { provider: "gitlab" }),
    ]).options;
    expect(options.map((o) => o.value)).toEqual([SYSTEM_ACCOUNT, gh.id]);
  });

  it("offers system credentials only while the host has no token", () => {
    const has = (list: StoredProviderToken[]) =>
      model("https://github.com/o/r.git", list).options.some((o) => o.value === SYSTEM_ACCOUNT);
    expect(has([])).toBe(true);
    expect(has([shared])).toBe(false);
  });

  it("has a single option when a token is the only account", () => {
    expect(model("https://github.com/o/r.git", [shared], []).options).toHaveLength(1);
  });

  it("offers nothing on an SSH remote", () => {
    expect(model("git@github.com:o/r.git", [shared]).options).toEqual([]);
  });

  it("selects the token for a URL with no username", () => {
    expect(model("https://github.com/o/r.git", [shared]).selected).toBe(valueOf(shared));
  });

  it("selects the gh account for its username in any case", () => {
    expect(model("https://octocat@github.com/o/r.git", [shared]).selected).toBe(gh.id);
  });

  it("selects the token a URL username names, over a newer one", () => {
    const named = tok("other");
    const newer = tok("newer", { savedAt: 2 });
    expect(model("https://other@github.com/o/r.git", [named, newer]).selected).toBe(valueOf(named));
  });

  it("selects the newest token for an unknown username, and system without one", () => {
    const older = tok("older");
    const newer = tok("newer", { savedAt: 2 });
    expect(model("https://nobody@github.com/o/r.git", [older, newer]).selected).toBe(valueOf(newer));
    expect(model("https://nobody@github.com/o/r.git", []).selected).toBe(SYSTEM_ACCOUNT);
  });
});

describe("remoteAccountPickerModel", () => {
  const github = acct("github.com", "alice");
  const ghe = acct("ghe.corp", "worker");

  it("offers exactly the accounts whose host matches the remote", () => {
    const model = remoteAccountPickerModel(remote("https://github.com/o/r.git"), [github, ghe]);
    expect(model.host).toBe("github.com");
    expect(model.matching).toEqual([github]);
    expect(model.note).toMatch(/Use a connected GitHub account/);
  });

  it("matches www GitHub remotes to github.com accounts while preserving credential scope", () => {
    const model = remoteAccountPickerModel(remote("https://alice@www.github.com/o/r.git"), [github, ghe]);
    expect(model.host).toBe("github.com");
    expect(model.credentialHost).toBe("www.github.com");
    expect(model.matching).toEqual([github]);
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
    expect(model.note).toMatch(/Git transport uses @alice/);
    expect(model.note).toMatch(/Git Credential Manager/);

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
    expect(model.note).toMatch(/GitLane authenticates git through glab/);
  });

  it("acknowledges a signed-in Origin CLI on Origin remotes", () => {
    const originStatus: ForgeAuthStatus = {
      provider: "cursor-origin",
      forge: "Cursor Origin",
      cli: "origin",
      authMethod: "Origin CLI",
      available: true,
      authenticated: true,
      loginCommand: "origin auth login",
      docsUrl: "x",
      notes: "y",
      account: { username: "ada@cursor.com" },
    };
    const model = remoteAccountPickerModel(
      remote("https://origin.cursor.com/siomkin/lattice.git"),
      [github],
      [originStatus],
    );
    expect(model.note).toMatch(/Signed in as @ada@cursor.com via origin/);
    expect(model.note).toMatch(/Git transport still uses this URL username/);
  });

  it("falls back to a plain system-credentials note for unknown or unparsable hosts", () => {
    expect(remoteAccountPickerModel(remote("https://git.corp.dev/o/r.git"), [github]).note).toMatch(
      /Git Credential Manager|credential helper/,
    );
    expect(remoteAccountPickerModel(remote("/local/path.git"), [github]).note).toMatch(
      /SSH key|Git Credential Manager|credential helper/,
    );
  });
});
