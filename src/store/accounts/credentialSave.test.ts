import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoSummary } from "@/lib/api";
import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { useRepo } from "@/store/repo";
import { useAccounts, type Account } from "@/store/accounts";
import { useNotifications } from "@/store/notifications";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const path = "repo-under-test";
const summary: RepoSummary = { path, workdir: path, headBranch: "main", headOid: "abc", detached: false, unborn: false, isWorktree: false };
const remote = (name: string, url: string) => ({ name, fetchUrl: url, pushUrl: url, isDefault: name === "origin" });
const origin = remote("origin", "https://Siomkin@github.com/siomkin/repo.git");

const shadowed = {
  kind: "auth",
  code: "credentialShadowed",
  message: "Git returned a saved credential for @x-access-token instead of @Siomkin.",
  credentialUsername: "x-access-token",
};
const authRejected = { kind: "auth", code: "credentialsMissing", message: "Authentication failed for 'https://github.com/siomkin/repo.git/'" };
const ghSiomkin: Account = {
  id: "gh:github.com:1",
  forge: "GitHub",
  provider: "gh",
  host: "github.com",
  accountId: "1",
  login: "Siomkin",
  label: "Siomkin",
  username: "Siomkin",
  name: "S",
  email: "s@example.com",
  color: "#5b8def",
  ref: { provider: "gh", host: "github.com", accountId: "1", login: "Siomkin" },
  active: true,
  healthy: true,
  healthError: "",
};
const offline = { kind: "network", code: "unreachable", message: "Could not resolve host: github.com" };

/** Answer `cmd` from `overrides` (a value, or a function of the args), else empty. */
function ipc(overrides: Record<string, unknown>) {
  invokeMock.mockImplementation((cmd: string, args: unknown) => {
    if (!(cmd in overrides)) return emptyIpcInvoke(cmd);
    const answer = overrides[cmd];
    const value = typeof answer === "function" ? (answer as (a: unknown) => unknown)(args) : answer;
    return value instanceof Error || (value && typeof value === "object" && "kind" in value)
      ? Promise.reject(value)
      : Promise.resolve(value);
  });
}

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(emptyIpcInvoke);
  useRepo.setState({ summary, remotes: [origin] });
  useNotifications.setState({ toasts: [] });
  useAccounts.setState({ accounts: [], providerTokens: {}, repoBindingKey: null });
});

describe("saveRemoteCredential outcomes", () => {
  it("returns a shadowed username, writes no remote URL and shows no toast", async () => {
    ipc({ approve_https_credential: shadowed });

    const outcome = await useAccounts.getState().saveRemoteCredential("origin", "Siomkin", "ghp_x");

    expect(outcome).toMatchObject({ ok: false, shadowedUsername: "x-access-token" });
    expect(invokeMock).not.toHaveBeenCalledWith("set_remote_username", expect.anything());
    expect(useNotifications.getState().toasts).toEqual([]);
  });

  it("writes the same username to the helper and the remote URL, then checks the remote", async () => {
    ipc({ list_remotes: [origin] });
    const outcome = await useAccounts.getState().saveRemoteCredential("origin", "Siomkin", "ghp_x");

    expect(invokeMock).toHaveBeenCalledWith("approve_https_credential", expect.objectContaining({ username: "Siomkin" }));
    expect(invokeMock).toHaveBeenCalledWith("set_remote_username", { path, name: "origin", username: "Siomkin" });
    expect(invokeMock).toHaveBeenCalledWith("check_remote_access", expect.objectContaining({ path, remote: "origin" }));
    expect(outcome).toEqual({ ok: true, checks: [{ remote: "origin", ok: true }], note: null });
  });
});

describe("saveHttpsCredential outcomes", () => {
  it("saves under the remote URL's spelling when only the case differs", async () => {
    const outcome = await useAccounts.getState().saveHttpsCredential("github.com", null, "siomkin", "ghp_x");

    expect(invokeMock).toHaveBeenCalledWith("approve_https_credential", expect.objectContaining({ username: "Siomkin" }));
    expect(outcome).toMatchObject({ ok: true, note: expect.stringContaining("@Siomkin") });
  });

  it("reports a missing helper without a toast", async () => {
    ipc({ approve_https_credential: { kind: "auth", code: "noCredentialHelper", message: "No Git credential helper is configured on this computer." } });

    const outcome = await useAccounts.getState().saveHttpsCredential("github.com", null, "Siomkin", "ghp_x");

    expect(outcome).toMatchObject({ ok: false, noCredentialHelper: true, shadowedUsername: null });
    expect(useNotifications.getState().toasts).toEqual([]);
  });

  it("reports nothing to check with no repository open", async () => {
    useRepo.setState({ summary: null, remotes: [] });

    const outcome = await useAccounts.getState().saveHttpsCredential("github.com", null, "siomkin", "ghp_x");

    expect(outcome).toEqual({ ok: true, checks: [], note: null });
    expect(invokeMock).not.toHaveBeenCalledWith("check_remote_access", expect.anything());
  });
});

describe("saveGithubToken", () => {
  it("stores a GitHub keychain token that transport then uses for the remote", async () => {
    const outcome = await useAccounts.getState().saveGithubToken("github.com", "siomkin", "ghp_x");

    expect(invokeMock).toHaveBeenCalledWith("save_provider_token", {
      provider: "github",
      host: "github.com",
      accountId: "siomkin",
      login: "siomkin",
      token: "ghp_x",
    });
    expect(outcome).toMatchObject({ ok: true, checks: [{ remote: "origin", ok: true }] });
    // `Siomkin@` in the URL still resolves to the token saved as `siomkin`.
    expect(useAccounts.getState().transportAuthForRemote("origin", "fetch")).toMatchObject({
      mode: "providerToken",
      provider: "github",
      credentialHost: "github.com",
      providerAccountId: "siomkin",
    });
  });

  it("offers the helper fallback when the keychain is unavailable", async () => {
    ipc({ save_provider_token: { kind: "internal", code: "keychain", message: "Could not save the token to the keychain" } });

    const outcome = await useAccounts.getState().saveGithubToken("github.com", "siomkin", "ghp_x");

    expect(outcome).toMatchObject({ ok: false, keychainUnavailable: true });
    expect(useAccounts.getState().providerTokens).toEqual({});
  });

  it("removes a token every checked remote refuses", async () => {
    ipc({ check_remote_access: authRejected });

    const outcome = await useAccounts.getState().saveGithubToken("github.com", "siomkin", "ghp_bad");

    expect(outcome).toMatchObject({ ok: false });
    expect(invokeMock).toHaveBeenCalledWith("delete_provider_token", { provider: "github", host: "github.com", accountId: "siomkin" });
    expect(useAccounts.getState().providerTokens).toEqual({});
  });

  it("keeps the token when one remote accepts it", async () => {
    useRepo.setState({ summary, remotes: [origin, remote("fork", "https://github.com/other/repo.git")] });
    ipc({ check_remote_access: (args: unknown) => ((args as { remote: string }).remote === "fork" ? authRejected : null) });

    const outcome = await useAccounts.getState().saveGithubToken("github.com", "siomkin", "ghp_x");

    expect(outcome).toMatchObject({ ok: true });
    expect(invokeMock).not.toHaveBeenCalledWith("delete_provider_token", expect.anything());
  });

  it("keeps the token when the check cannot reach the remote", async () => {
    ipc({ check_remote_access: offline });

    const outcome = await useAccounts.getState().saveGithubToken("github.com", "siomkin", "ghp_x");

    expect(outcome).toMatchObject({ ok: true, checks: [{ remote: "origin", ok: false, kind: "network" }] });
    expect(Object.keys(useAccounts.getState().providerTokens)).toHaveLength(1);
  });

  it("keeps the previous token when the replacement is refused", async () => {
    await useAccounts.getState().saveGithubToken("github.com", "Siomkin", "ghp_good");
    const before = useAccounts.getState().providerTokens;
    ipc({ check_remote_access: authRejected });

    const outcome = await useAccounts.getState().saveGithubToken("github.com", "siomkin", "ghp_typo");

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining("previous token is still saved") });
    expect(useAccounts.getState().providerTokens).toEqual(before);
    const deleted = invokeMock.mock.calls.filter(([cmd]) => cmd === "delete_provider_token");
    expect(deleted).toHaveLength(1);
    expect((deleted[0][1] as { accountId: string }).accountId).toMatch(/^siomkin#/);
  });

  it("keeps a token that signed in but may not read this repository", async () => {
    ipc({
      check_remote_access: { kind: "auth", code: "notFoundOrDenied", message: "remote: Repository not found.\nfatal: repository 'https://github.com/siomkin/repo.git/' not found" },
    });

    const outcome = await useAccounts.getState().saveGithubToken("github.com", "siomkin", "ghp_scoped");

    expect(outcome).toMatchObject({ ok: true, checks: [{ remote: "origin", ok: false, code: "notFoundOrDenied" }] });
    expect(invokeMock).not.toHaveBeenCalledWith("delete_provider_token", expect.anything());
  });

  it("keys the keychain item by the lowercased host the bridge looks up", async () => {
    await useAccounts.getState().saveGithubToken(" GitHub.com ", "siomkin", "ghp_x");

    expect(invokeMock).toHaveBeenCalledWith("save_provider_token", expect.objectContaining({ host: "github.com" }));
    expect(Object.values(useAccounts.getState().providerTokens)[0].credentialHost).toBe("github.com");
  });

  it("overwrites a staged keychain id in place instead of orphaning it", async () => {
    await useAccounts.getState().saveGithubToken("github.com", "siomkin", "ghp_one");
    await useAccounts.getState().saveGithubToken("github.com", "siomkin", "ghp_two");
    const staged = Object.values(useAccounts.getState().providerTokens)[0].accountId;
    expect(staged).toMatch(/^siomkin#/);

    await useAccounts.getState().saveProviderToken("github", "github.com", "siomkin", "ghp_three");

    expect(invokeMock).toHaveBeenLastCalledWith("save_provider_token", expect.objectContaining({ accountId: staged }));
    expect(Object.values(useAccounts.getState().providerTokens).map((t) => t.accountId)).toEqual([staged]);
  });

  it("replaces a case-variant token once the new one is accepted", async () => {
    await useAccounts.getState().saveGithubToken("github.com", "Siomkin", "ghp_old");

    await useAccounts.getState().saveGithubToken("github.com", "siomkin", "ghp_new");

    const tokens = Object.values(useAccounts.getState().providerTokens);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].accountId).toMatch(/^siomkin#/);
    expect(invokeMock).toHaveBeenCalledWith("delete_provider_token", { provider: "github", host: "github.com", accountId: "Siomkin" });
  });

  it("checks with the new token even where a fetch would use gh", async () => {
    useAccounts.setState({ accounts: [ghSiomkin] });

    await useAccounts.getState().saveGithubToken("github.com", "siomkin", "ghp_x");

    expect(invokeMock).toHaveBeenCalledWith("check_remote_access", {
      path,
      remote: "origin",
      auth: expect.objectContaining({ mode: "providerToken", providerAccountId: "siomkin" }),
    });
  });

  it("leaves a remote bound to a gh account on gh", async () => {
    await useAccounts.getState().saveGithubToken("github.com", "siomkin", "ghp_x");
    useAccounts.setState({ accounts: [ghSiomkin] });

    expect(useAccounts.getState().transportAuthForRemote("origin", "fetch")).toMatchObject({ mode: "githubGh" });
  });
});

describe("saveTransportToken (GitLab, Bitbucket)", () => {
  const lab = remote("origin", "https://gitlab.com/group/proj.git");

  it("stores a GitLab keychain token, checks the remote with it, and transport then uses it", async () => {
    useRepo.setState({ summary, remotes: [lab] });

    const outcome = await useAccounts.getState().saveTransportToken("gitlab", "gitlab.com", "ada", "glpat-x");

    expect(invokeMock).toHaveBeenCalledWith("save_provider_token", {
      provider: "gitlab",
      host: "gitlab.com",
      accountId: "ada",
      login: "ada",
      token: "glpat-x",
    });
    expect(invokeMock).toHaveBeenCalledWith("check_remote_access", {
      path,
      remote: "origin",
      auth: expect.objectContaining({ mode: "providerToken", provider: "gitlab", providerAccountId: "ada" }),
    });
    expect(outcome).toMatchObject({ ok: true, checks: [{ remote: "origin", ok: true }] });
    // A bare GitLab URL resolves to the GitLane token, ahead of the helper.
    expect(useAccounts.getState().transportAuthForRemote("origin", "fetch")).toMatchObject({
      mode: "providerToken",
      provider: "gitlab",
      username: "ada",
      providerAccountId: "ada",
    });
  });

  it("drops a Bitbucket token every remote refuses", async () => {
    useRepo.setState({ summary, remotes: [remote("origin", "https://bitbucket.org/ws/repo.git")] });
    ipc({ check_remote_access: { kind: "auth", code: "credentialsRejected", message: "Authentication failed" } });

    const outcome = await useAccounts
      .getState()
      .saveTransportToken("bitbucket", "bitbucket.org", "x-bitbucket-api-token-auth", "tok");

    expect(outcome).toMatchObject({ ok: false });
    expect(invokeMock).toHaveBeenCalledWith("delete_provider_token", expect.objectContaining({ provider: "bitbucket" }));
    expect(useAccounts.getState().providerTokens).toEqual({});
  });

  it("asks for the username in generic words", async () => {
    await expect(useAccounts.getState().saveTransportToken("gitlab", "gitlab.com", " ", "t")).resolves.toMatchObject({
      ok: false,
      message: "Enter the HTTPS username.",
    });
    await expect(useAccounts.getState().saveTransportToken("gitlab", "gitlab.com", "ada", " ")).resolves.toMatchObject({
      ok: false,
      message: "Paste an access token.",
    });
  });
});

describe("forgetHttpsCredential", () => {
  it("returns the error without a toast when inline", async () => {
    ipc({ reject_https_credential: { kind: "git", message: "GCM could not erase" } });

    const error = await useAccounts.getState().forgetHttpsCredential("github.com", null, "x-access-token", undefined, true);

    expect(error).toContain("GCM could not erase");
    expect(useNotifications.getState().toasts).toEqual([]);
  });

  it("resolves null once the helper accepted the erase", async () => {
    await expect(useAccounts.getState().forgetHttpsCredential("github.com", null, "x-access-token")).resolves.toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("reject_https_credential", {
      credentialHost: "github.com",
      path: null,
      username: "x-access-token",
    });
  });
});
