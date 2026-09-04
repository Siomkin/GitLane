import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ForgeAuthStatus, type RepoSummary } from "@/lib/api";
import { emptyIpcInvoke, emptyIpcPayload } from "@/test/ipcFixtures";
import { useRepo } from "@/store/repo";
import { useAccounts, type Account } from "@/store/accounts";
import { useNotifications } from "@/store/notifications";
import { usePulls } from "@/store/pulls";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const path = "repo-under-test";
const summary: RepoSummary = { path, workdir: path, headBranch: "main", headOid: "abc", detached: false };

const account: Account = {
  id: "gh:github.com:1",
  forge: "GitHub",
  provider: "gh",
  host: "github.com",
  accountId: "1",
  login: "octocat",
  label: "octocat",
  username: "octocat",
  name: "Octo Cat",
  email: "octo@example.com",
  color: "#5b8def",
  ref: { provider: "gh", host: "github.com", accountId: "1", login: "octocat" },
  active: true,
  healthy: true,
  healthError: "",
};

const identityCmds = (calls: unknown[][]) =>
  calls.filter(([cmd]) => cmd === "set_repo_identity" || cmd === "clear_repo_identity");

const remoteInfo = (name: string, url: string, isDefault = false) => ({
  name,
  fetchUrl: url,
  pushUrl: url,
  isDefault,
});
const origin = remoteInfo("origin", "https://github.com/owner/repo.git", true);
const bucket = remoteInfo("bucket", "https://alice@bitbucket.org/team/repo.git");
const loadPullRequests = usePulls.getState().loadPullRequests;

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(emptyIpcInvoke);
  useRepo.setState({ summary, remotes: [] });
  useNotifications.setState({ toasts: [] });
  usePulls.setState({ loadPullRequests });
  useAccounts.setState({
    accounts: [account],
    repoAccountId: null,
    repoRemoteAccountIds: {},
    repoBindingKey: null,
    repoAccountRef: null,
    repoIdentity: null,
  });
});

describe("per-remote accounts — git-native (URL username, gitcredentials(7))", () => {
  const originWithUser = remoteInfo("origin", "https://octocat@github.com/owner/repo.git", true);

  it("derives the per-remote accounts from the remote URLs' usernames", () => {
    useRepo.setState({ summary, remotes: [originWithUser, bucket] });

    useAccounts.getState().syncRepoAccount(path);

    expect(useAccounts.getState().repoRemoteAccountIds).toEqual({
      origin: account.id, // https://octocat@github.com → @octocat
      bucket: null, // no matching gh login on bitbucket.org
    });
    // The default remote's derived account also drives the PR mirror.
    expect(useAccounts.getState().repoAccountId).toBe(account.id);
    // Nothing is persisted app-side — git config is the source of truth.
    expect(localStorage.getItem("gitlane.repoAccounts")).toBeNull();
  });

  it("a URL without a username derives no account (system credential lookup)", () => {
    useRepo.setState({ summary, remotes: [origin, bucket] });
    useAccounts.setState({ activeAccountId: account.id });

    useAccounts.getState().syncRepoAccount(path);

    expect(useAccounts.getState().repoRemoteAccountIds).toEqual({ origin: null, bucket: null });
    // The default HTTPS remote is the source of truth for the provider account:
    // no URL username means system git credentials and no PR account selected.
    expect(useAccounts.getState().repoAccountId).toBeNull();
  });

  it("migrates a v2 PR account onto a plain HTTPS default remote", async () => {
    localStorage.setItem("gitlane.repoAccounts", JSON.stringify({ [path]: { version: 2, ...account.ref } }));
    useRepo.setState({ summary, remotes: [origin] });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_remotes") return [originWithUser];
      return emptyIpcPayload(cmd);
    });

    useAccounts.getState().syncRepoAccount(path);

    expect(useAccounts.getState().repoRemoteAccountIds).toEqual({ origin: null });
    // The stored binding remains available while the one-shot URL migration runs.
    expect(useAccounts.getState().repoAccountId).toBe(account.id);
    expect(useAccounts.getState().repoAccountRef).toEqual(account.ref);
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("set_remote_username", {
        path,
        name: "origin",
        username: "octocat",
      }),
    );
  });

  it("migrates interim v3 remote bindings into git URL usernames", async () => {
    localStorage.setItem(
      "gitlane.repoAccounts",
      JSON.stringify({
        [path]: {
          version: 3,
          remotes: {
            origin: account.ref,
            bucket: { unbound: true },
          },
        },
      }),
    );
    useRepo.setState({ summary, remotes: [origin, bucket] });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_remotes") return [originWithUser, bucket];
      return emptyIpcPayload(cmd);
    });

    useAccounts.getState().syncRepoAccount(path);

    expect(useAccounts.getState().repoAccountId).toBe(account.id);
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("set_remote_username", {
        path,
        name: "origin",
        username: "octocat",
      }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("set_remote_username", {
      path,
      name: "bucket",
      username: null,
    });
    await vi.waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("gitlane.repoAccounts") ?? "{}");
      expect(stored[path]).toEqual({ version: 2, ...account.ref });
    });
  });

  it("does not delete interim v3 bindings before accounts are loaded", async () => {
    const entry = {
      version: 3,
      remotes: {
        origin: account.ref,
      },
    };
    localStorage.setItem("gitlane.repoAccounts", JSON.stringify({ [path]: entry }));
    useAccounts.setState({ accounts: [], activeAccountId: account.id });
    useRepo.setState({ summary, remotes: [origin] });

    useAccounts.getState().syncRepoAccount(path);

    expect(invokeMock).not.toHaveBeenCalledWith("set_remote_username", expect.anything());
    expect(JSON.parse(localStorage.getItem("gitlane.repoAccounts") ?? "{}")[path]).toEqual(entry);
    expect(useAccounts.getState().repoAccountId).toBeNull();
  });

  it("keeps unresolved interim v3 bindings for a later account refresh", async () => {
    const entry = {
      version: 3,
      remotes: {
        origin: account.ref,
        bucket: { provider: "gh", host: "github.com", accountId: "missing", login: "missing" },
      },
    };
    localStorage.setItem("gitlane.repoAccounts", JSON.stringify({ [path]: entry }));
    useRepo.setState({ summary, remotes: [origin, bucket] });

    useAccounts.getState().syncRepoAccount(path);

    expect(invokeMock).not.toHaveBeenCalledWith("set_remote_username", expect.anything());
    expect(JSON.parse(localStorage.getItem("gitlane.repoAccounts") ?? "{}")[path]).toEqual(entry);
  });

  it("setRemoteAccount writes the default remote username and updates the legacy PR binding", async () => {
    useRepo.setState({ summary, remotes: [origin, bucket] });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_remotes") return [originWithUser, bucket];
      return emptyIpcPayload(cmd);
    });

    await useAccounts.getState().setRemoteAccount("origin", account.id);

    expect(invokeMock).toHaveBeenCalledWith("set_remote_username", {
      path,
      name: "origin",
      username: "octocat",
    });
    expect(JSON.parse(localStorage.getItem("gitlane.repoAccounts") ?? "{}")[path]).toEqual({
      version: 2,
      ...account.ref,
    });
    // No identity writes from a push-auth change (two-tier safety).
    expect(identityCmds(invokeMock.mock.calls)).toHaveLength(0);
  });

  it("does not publish a PR account when the default HTTPS remote update fails", async () => {
    localStorage.setItem(
      "gitlane.repoAccounts",
      JSON.stringify({ [path]: { version: 2, unbound: true } }),
    );
    useRepo.setState({ summary, remotes: [origin] });
    const loadPrs = vi.fn().mockResolvedValue(undefined);
    usePulls.setState({ loadPullRequests: loadPrs });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "set_remote_username") throw new Error("remote config is read-only");
      return emptyIpcPayload(cmd);
    });

    await useAccounts.getState().setRepoAccount(account.id);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(useAccounts.getState().repoAccountId).toBeNull();
    expect(useAccounts.getState().repoAccountRef).toBeNull();
    expect(JSON.parse(localStorage.getItem("gitlane.repoAccounts") ?? "{}")[path]).toEqual({
      version: 2,
      unbound: true,
    });
    expect(invokeMock).not.toHaveBeenCalledWith("list_remotes", expect.anything());
    expect(loadPrs).not.toHaveBeenCalled();
    expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toContain(
      "remote config is read-only",
    );
  });

  it("does not clear the PR account when stripping the HTTPS username fails", async () => {
    localStorage.setItem(
      "gitlane.repoAccounts",
      JSON.stringify({ [path]: { version: 2, ...account.ref } }),
    );
    useAccounts.setState({ repoAccountId: account.id, repoAccountRef: account.ref });
    useRepo.setState({ summary, remotes: [originWithUser] });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "set_remote_username") throw new Error("cannot rewrite remote");
      return emptyIpcPayload(cmd);
    });

    await useAccounts.getState().setRepoAccount(null);

    expect(useAccounts.getState().repoAccountId).toBe(account.id);
    expect(useAccounts.getState().repoAccountRef).toEqual(account.ref);
    expect(JSON.parse(localStorage.getItem("gitlane.repoAccounts") ?? "{}")[path]).toEqual({
      version: 2,
      ...account.ref,
    });
    expect(invokeMock).not.toHaveBeenCalledWith("list_remotes", expect.anything());
  });

  it("clearing the default remote strips the URL username and clears the legacy PR binding", async () => {
    localStorage.setItem("gitlane.repoAccounts", JSON.stringify({ [path]: { version: 2, ...account.ref } }));
    useRepo.setState({ summary, remotes: [originWithUser, bucket] });
    const loadPrs = vi.fn().mockResolvedValue(undefined);
    usePulls.setState({ loadPullRequests: loadPrs });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_remotes") return [origin, bucket];
      return emptyIpcPayload(cmd);
    });

    await useAccounts.getState().setRemoteAccount("origin", null);

    expect(invokeMock).toHaveBeenCalledWith("set_remote_username", {
      path,
      name: "origin",
      username: null,
    });
    expect(JSON.parse(localStorage.getItem("gitlane.repoAccounts") ?? "{}")[path]).toEqual({
      version: 2,
      unbound: true,
    });
    expect(useAccounts.getState().repoAccountId).toBeNull();
    expect(loadPrs).toHaveBeenCalledTimes(1);
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });

  it("setRepoAccount(null) also refreshes PRs when it clears a plain HTTPS default remote", async () => {
    localStorage.setItem("gitlane.repoAccounts", JSON.stringify({ [path]: { version: 2, ...account.ref } }));
    useRepo.setState({ summary, remotes: [originWithUser] });
    const loadPrs = vi.fn().mockResolvedValue(undefined);
    usePulls.setState({ loadPullRequests: loadPrs });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_remotes") return [origin];
      return emptyIpcPayload(cmd);
    });

    await useAccounts.getState().setRepoAccount(null);

    expect(invokeMock).toHaveBeenCalledWith("set_remote_username", {
      path,
      name: "origin",
      username: null,
    });
    expect(loadPrs).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to the active account when a stored binding cannot resolve", () => {
    localStorage.setItem(
      "gitlane.repoAccounts",
      JSON.stringify({
        [path]: { version: 2, provider: "gh", host: "github.com", accountId: "missing", login: "missing" },
      }),
    );
    useAccounts.setState({ activeAccountId: account.id });
    useRepo.setState({ summary, remotes: [] });

    useAccounts.getState().syncRepoAccount(path);

    expect(useAccounts.getState().repoAccountId).toBeNull();
    expect(useAccounts.getState().repoAccountRef).toBeNull();
  });

  it("refuses to bind an SSH remote (the SSH key is the account)", async () => {
    const lab = remoteInfo("lab", "git@gitlab.com:group/repo.git");
    useRepo.setState({ summary, remotes: [origin, lab] });
    invokeMock.mockClear();

    await useAccounts.getState().setRemoteAccount("lab", account.id);

    expect(invokeMock).not.toHaveBeenCalledWith("set_remote_username", expect.anything());
  });

  it("accountRefForRemote maps the derived pick to the ref PR calls send", () => {
    useRepo.setState({ summary, remotes: [originWithUser, bucket] });
    useAccounts.getState().syncRepoAccount(path);

    expect(useAccounts.getState().accountRefForRemote("origin")).toEqual(account.ref);
    expect(useAccounts.getState().accountRefForRemote("bucket")).toBeNull();
    expect(useAccounts.getState().accountRefForRemote("nonexistent")).toBeNull();
  });

  it("transportAuthForRemote maps GitHub to gh and non-GitHub to credential helpers", () => {
    useRepo.setState({ summary, remotes: [originWithUser, bucket] });
    useAccounts.getState().syncRepoAccount(path);

    expect(useAccounts.getState().transportAuthForRemote("origin")).toEqual({
      mode: "githubGh",
      provider: "github",
      host: "github.com",
      credentialHost: "github.com",
      username: "octocat",
      accountRef: account.ref,
    });
    expect(useAccounts.getState().transportAuthForRemote("bucket")).toEqual({
      mode: "credentialHelper",
      provider: "bitbucket",
      host: "bitbucket.org",
      credentialHost: "bitbucket.org",
      username: "alice",
    });
  });

  it("selects independent accounts for a remote's split fetch and push authorities", () => {
    const fetchAccount: Account = {
      ...account,
      id: "gh:fetch.github.com:fetch-account",
      host: "fetch.github.com",
      accountId: "fetch-account",
      login: "fetch-user",
      username: "fetch-user",
      ref: {
        provider: "gh",
        host: "fetch.github.com",
        accountId: "fetch-account",
        login: "fetch-user",
      },
    };
    const pushAccount: Account = {
      ...account,
      id: "gh:push.github.com:push-account",
      host: "push.github.com",
      accountId: "push-account",
      login: "push-user",
      username: "push-user",
      ref: {
        provider: "gh",
        host: "push.github.com",
        accountId: "push-account",
        login: "push-user",
      },
    };
    useAccounts.setState({ accounts: [fetchAccount, pushAccount] });
    useRepo.setState({
      summary,
      remotes: [
        {
          name: "origin",
          fetchUrl: "https://fetch-user@fetch.github.com/owner/repo.git",
          pushUrl: "https://push-user@push.github.com/owner/repo.git",
          isDefault: true,
        },
      ],
    });

    expect(useAccounts.getState().transportAuthForRemote("origin", "fetch")).toEqual({
      mode: "githubGh",
      provider: "github",
      host: "fetch.github.com",
      credentialHost: "fetch.github.com",
      username: "fetch-user",
      accountRef: fetchAccount.ref,
    });
    // Push remains the default direction for existing push-family callers.
    expect(useAccounts.getState().transportAuthForRemote("origin")).toEqual({
      mode: "githubGh",
      provider: "github",
      host: "push.github.com",
      credentialHost: "push.github.com",
      username: "push-user",
      accountRef: pushAccount.ref,
    });
  });

  it("matches www GitHub remotes to github.com accounts while preserving helper scope", () => {
    useRepo.setState({
      summary,
      remotes: [remoteInfo("origin", "https://octocat@www.github.com/owner/repo.git", true)],
    });
    useAccounts.getState().syncRepoAccount(path);

    expect(useAccounts.getState().repoRemoteAccountIds).toEqual({ origin: account.id });
    expect(useAccounts.getState().repoAccountId).toBe(account.id);
    expect(useAccounts.getState().transportAuthForRemote("origin")).toEqual({
      mode: "githubGh",
      provider: "github",
      host: "github.com",
      credentialHost: "www.github.com",
      username: "octocat",
      accountRef: account.ref,
    });
  });

  it("transportAuthForRemote wires glab for a signed-in GitLab remote, even with no URL username", () => {
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
    useAccounts.setState({ accounts: [], forgeAuth: [glabStatus] });
    useRepo.setState({
      summary,
      remotes: [remoteInfo("lab", "https://gitlab.com/siomkin/gitlanelab.git")],
    });

    expect(useAccounts.getState().transportAuthForRemote("lab")).toEqual({
      mode: "gitlabGlab",
      provider: "gitlab",
      host: "gitlab.com",
      credentialHost: "gitlab.com",
      username: null,
    });
  });

  it("transportAuthForRemote falls back to the credential helper when glab isn't signed in", () => {
    const glabStatus: ForgeAuthStatus = {
      provider: "gitlab",
      forge: "GitLab",
      cli: "glab",
      authMethod: "GitLab CLI",
      available: true,
      authenticated: false,
      loginCommand: "glab auth login",
      docsUrl: "x",
      notes: "y",
    };
    useAccounts.setState({ accounts: [], forgeAuth: [glabStatus] });
    useRepo.setState({
      summary,
      remotes: [remoteInfo("lab", "https://siomkin@gitlab.com/siomkin/gitlanelab.git")],
    });

    expect(useAccounts.getState().transportAuthForRemote("lab")).toEqual({
      mode: "credentialHelper",
      provider: "gitlab",
      host: "gitlab.com",
      credentialHost: "gitlab.com",
      username: "siomkin",
    });
  });

  it("reuses an exact non-Azure path-scoped helper marker for a bare remote URL", () => {
    localStorage.setItem(
      "gitlane.forgeCredentials",
      JSON.stringify({
        gitlab: {
          provider: "gitlab",
          credentialHost: "gitlab.com",
          path: "group one/repo.git",
          username: "ada",
          helper: "Git Credential Manager",
          savedAt: 1,
        },
      }),
    );
    useAccounts.setState({ accounts: [], forgeAuth: [] });
    useRepo.setState({
      summary,
      remotes: [remoteInfo("lab", "https://gitlab.com/group%20one/repo.git")],
    });

    expect(useAccounts.getState().transportAuthForRemote("lab")).toEqual({
      mode: "credentialHelper",
      provider: "gitlab",
      host: "gitlab.com",
      credentialHost: "gitlab.com",
      username: null,
      useHttpPath: true,
    });
  });

  it("does not apply a saved non-Azure path scope to another repository or username", () => {
    localStorage.setItem(
      "gitlane.forgeCredentials",
      JSON.stringify({
        gitlab: {
          provider: "gitlab",
          credentialHost: "gitlab.com",
          path: "group/repo.git",
          username: "ada",
          helper: "Git Credential Manager",
          savedAt: 1,
        },
      }),
    );
    useAccounts.setState({ accounts: [], forgeAuth: [] });

    useRepo.setState({
      summary,
      remotes: [remoteInfo("other", "https://gitlab.com/group/other.git")],
    });
    expect(useAccounts.getState().transportAuthForRemote("other")).toBeNull();

    useRepo.setState({
      summary,
      remotes: [remoteInfo("lab", "https://grace@gitlab.com/group/repo.git")],
    });
    expect(useAccounts.getState().transportAuthForRemote("lab")).toEqual({
      mode: "credentialHelper",
      provider: "gitlab",
      host: "gitlab.com",
      credentialHost: "gitlab.com",
      username: "grace",
    });
  });

  it("enables Azure path matching even when the remote URL has no username", () => {
    useAccounts.setState({ accounts: [], forgeAuth: [] });
    useRepo.setState({
      summary,
      remotes: [remoteInfo("azure", "https://dev.azure.com/contoso/Project/_git/repo.git")],
    });

    expect(useAccounts.getState().transportAuthForRemote("azure")).toEqual({
      mode: "credentialHelper",
      provider: "azure-devops",
      host: "dev.azure.com",
      credentialHost: "dev.azure.com",
      username: null,
      useHttpPath: true,
    });
  });

  it("transportAuthForRemote requires an exact credential host for custom ports", () => {
    const portAccount: Account = {
      ...account,
      id: "gh:ghe.test:worker",
      host: "ghe.test",
      login: "worker",
      username: "worker",
      ref: { provider: "gh", host: "ghe.test", accountId: "2", login: "worker" },
    };
    useAccounts.setState({ accounts: [portAccount] });
    useRepo.setState({
      summary,
      remotes: [remoteInfo("ghe", "https://worker@ghe.test:8443/owner/repo.git")],
    });

    expect(useAccounts.getState().transportAuthForRemote("ghe")).toEqual({
      mode: "credentialHelper",
      provider: "other",
      host: "ghe.test",
      credentialHost: "ghe.test:8443",
      username: "worker",
    });

    useAccounts.setState({
      accounts: [
        {
          ...portAccount,
          id: "gh:ghe.test:8443:worker",
          host: "ghe.test:8443",
          ref: { provider: "gh", host: "ghe.test:8443", accountId: "3", login: "worker" },
        },
      ],
    });

    expect(useAccounts.getState().transportAuthForRemote("ghe")).toEqual({
      mode: "githubGh",
      provider: "github",
      host: "ghe.test",
      credentialHost: "ghe.test:8443",
      username: "worker",
      accountRef: { provider: "gh", host: "ghe.test:8443", accountId: "3", login: "worker" },
    });
  });

  it("setRemoteUsername writes a non-GitHub HTTPS username into the remote URL", async () => {
    const lab = remoteInfo("lab", "https://gitlab.com/group/repo.git");
    useRepo.setState({ summary, remotes: [lab] });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_remotes") return [remoteInfo("lab", "https://ada@gitlab.com/group/repo.git")];
      return emptyIpcPayload(cmd);
    });

    await useAccounts.getState().setRemoteUsername("lab", "ada");

    expect(invokeMock).toHaveBeenCalledWith("set_remote_username", {
      path,
      name: "lab",
      username: "ada",
    });
    expect(identityCmds(invokeMock.mock.calls)).toHaveLength(0);
  });
});
