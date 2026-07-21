import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { ForgeKind, type ForgeAuthStatus, type RepoForge, type RepoSummary } from "@/lib/api";
import { useRepo } from "./repo";
import { useAccounts, type Account, type StoredProviderToken } from "./accounts";
import { useNotifications } from "./notifications";
import { usePulls } from "./pulls";

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
  invokeMock.mockResolvedValue(null);
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

describe("setRepoAccount — Tier 2 binding never touches commit identity", () => {
  it("binds the account without writing user.name/user.email", async () => {
    await useAccounts.getState().setRepoAccount(account.id);
    expect(useAccounts.getState().repoAccountId).toBe(account.id);
    expect(useAccounts.getState().repoAccountRef).toEqual(account.ref);
    // The decoupled path must not write or clear the commit identity.
    expect(identityCmds(invokeMock.mock.calls)).toHaveLength(0);
  });

  it("unbinding (null) does not clear the applied profile's identity", async () => {
    await useAccounts.getState().setRepoAccount(account.id);
    invokeMock.mockClear();
    await useAccounts.getState().setRepoAccount(null);
    expect(useAccounts.getState().repoAccountId).toBeNull();
    expect(identityCmds(invokeMock.mock.calls)).toHaveLength(0);
  });
});

describe("durable 'No account' across repo reopen", () => {
  it("explicit unbind stays unbound on reopen instead of reverting to the active account", async () => {
    useAccounts.setState({ activeAccountId: account.id });
    await useAccounts.getState().setRepoAccount(null);
    // Simulate closing and reopening the repo.
    useAccounts.setState({ repoAccountId: account.id, repoAccountRef: account.ref });
    useAccounts.getState().syncRepoAccount(path);
    expect(useAccounts.getState().repoAccountId).toBeNull();
    expect(useAccounts.getState().repoAccountRef).toBeNull();
  });

  it("a never-configured repo still defaults to the active account", () => {
    useAccounts.setState({ activeAccountId: account.id });
    useAccounts.getState().syncRepoAccount("some/other/repo");
    expect(useAccounts.getState().repoAccountId).toBe(account.id);
  });
});

describe("v2 binding survives an account going unhealthy (GL-119)", () => {
  // A repo bound while the account was healthy stores its stable numeric user id
  // (gh:host:<id>). When the account later returns unhealthy the backend skips
  // the whoami, so its id falls back to the login (gh:host:<login>). The binding
  // must still resolve — otherwise the account vanishes instead of showing the
  // "needs re-auth" badge, defeating the whole point of the health flag.
  const boundByNumericId = () =>
    localStorage.setItem(
      "gitlane.repoAccounts",
      JSON.stringify({
        [path]: { version: 2, provider: "gh", host: "github.com", accountId: "1234", login: "octocat" },
      }),
    );

  it("re-resolves a numerically-bound account that returns under its login id", () => {
    boundByNumericId();
    const unhealthy: Account = {
      ...account,
      id: "gh:github.com:octocat",
      accountId: "octocat",
      ref: { provider: "gh", host: "github.com", accountId: "octocat", login: "octocat" },
      healthy: false,
      healthError: "token invalid (HTTP 401)",
    };
    useAccounts.setState({
      accounts: [unhealthy],
      repoAccountId: null,
      repoAccountRef: null,
      repoBindingKey: null,
    });

    useAccounts.getState().syncRepoAccount(path);

    // Resolved via the {provider, host, login} fallback, not lost.
    expect(useAccounts.getState().repoAccountId).toBe("gh:github.com:octocat");
    expect(useAccounts.getState().repoAccountRef).toEqual(unhealthy.ref);
    // The stored binding is untouched, so it re-pins to the numeric id on recovery.
    const stored = JSON.parse(localStorage.getItem("gitlane.repoAccounts")!)[path];
    expect(stored.accountId).toBe("1234");
  });

  it("does not cross-match a different login on the same host", () => {
    boundByNumericId();
    const other: Account = {
      ...account,
      id: "gh:github.com:hubot",
      accountId: "hubot",
      login: "hubot",
      username: "hubot",
      ref: { provider: "gh", host: "github.com", accountId: "hubot", login: "hubot" },
    };
    useAccounts.setState({
      accounts: [other],
      activeAccountId: null,
      repoAccountId: null,
      repoAccountRef: null,
      repoBindingKey: null,
    });

    useAccounts.getState().syncRepoAccount(path);

    // A non-matching login stays unbound rather than binding the wrong account.
    expect(useAccounts.getState().repoAccountId).toBeNull();
  });
});

describe("loadForgeAuth — fast auth, background identity", () => {
  it("lists authenticated forges immediately, then merges the resolved account", async () => {
    // Keep the whoami pending so the intermediate "resolving" state is observable.
    let resolveAccount!: (v: { username: string } | null) => void;
    const pending = new Promise<{ username: string } | null>((r) => {
      resolveAccount = r;
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "forge_auth_statuses") {
        return [
          {
            provider: "gitlab",
            forge: "GitLab",
            cli: "glab",
            authMethod: "GitLab CLI",
            available: true,
            authenticated: true,
            loginCommand: "glab auth login",
            docsUrl: "x",
            notes: "y",
          },
        ];
      }
      if (cmd === "forge_account") return pending;
      return null;
    });
    useAccounts.setState({ forgeAuth: [], forgeAuthLoading: false, forgeAccountsLoading: [] });

    await useAccounts.getState().loadForgeAuth(true);
    // Immediately after: the forge is known and marked as resolving, no account yet.
    expect(useAccounts.getState().forgeAccountsLoading).toEqual(["gitlab"]);
    expect(useAccounts.getState().forgeAuth[0].account).toBeUndefined();

    // Once the background whoami resolves it merges into the matching entry.
    resolveAccount({ username: "ada" });
    await vi.waitFor(() => expect(useAccounts.getState().forgeAccountsLoading).toEqual([]));
    expect(useAccounts.getState().forgeAuth[0].account).toEqual({ username: "ada" });
  });

  it("drops a stale whoami from a superseded refresh (no merge onto a signed-out row)", async () => {
    let resolveStale!: (v: { username: string }) => void;
    const stale = new Promise<{ username: string }>((r) => {
      resolveStale = r;
    });
    let statusCall = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "forge_auth_statuses") {
        statusCall += 1;
        const authenticated = statusCall === 1; // signed out on the 2nd refresh
        return [
          { provider: "gitlab", forge: "GitLab", cli: "glab", authMethod: "GitLab CLI", available: true, authenticated, loginCommand: "x", docsUrl: "y", notes: "z" },
        ];
      }
      if (cmd === "forge_account") return stale; // only load #1 enqueues a whoami
      return null;
    });
    useAccounts.setState({ forgeAuth: [], forgeAuthLoading: false, forgeAccountsLoading: [] });

    await useAccounts.getState().loadForgeAuth(true); // load #1: authed, whoami pending
    expect(useAccounts.getState().forgeAccountsLoading).toEqual(["gitlab"]);
    await useAccounts.getState().loadForgeAuth(true); // load #2: signed out, supersedes #1
    expect(useAccounts.getState().forgeAuth[0].authenticated).toBe(false);
    expect(useAccounts.getState().forgeAccountsLoading).toEqual([]);

    // The stale #1 whoami resolves — it must not merge onto the now-signed-out row.
    resolveStale({ username: "ada" });
    await Promise.resolve();
    await Promise.resolve();
    expect(useAccounts.getState().forgeAuth[0].account).toBeUndefined();
  });

  it("a forced refresh supersedes an in-flight status probe", async () => {
    let resolveFirst!: (v: unknown) => void;
    const firstProbe = new Promise((r) => {
      resolveFirst = r;
    });
    let call = 0;
    const row = (forge: string, authenticated: boolean) => ({
      provider: "gitlab",
      forge,
      cli: "glab",
      authMethod: "GitLab CLI",
      available: true,
      authenticated,
      loginCommand: "x",
      docsUrl: "y",
      notes: "z",
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "forge_auth_statuses") {
        call += 1;
        return call === 1 ? firstProbe : [row("GitLab (latest)", false)];
      }
      return null;
    });
    useAccounts.setState({ forgeAuth: [], forgeAuthLoading: false, forgeAccountsLoading: [] });

    const p1 = useAccounts.getState().loadForgeAuth(true); // in-flight (pending probe)
    const p2 = useAccounts.getState().loadForgeAuth(true); // forced — supersedes #1
    await p2;
    expect(useAccounts.getState().forgeAuth[0].forge).toBe("GitLab (latest)");
    expect(useAccounts.getState().forgeAuthLoading).toBe(false);

    // The superseded #1 probe finally resolves — it must not clobber the latest.
    resolveFirst([row("GitLab (stale)", true)]);
    await p1;
    await Promise.resolve();
    expect(useAccounts.getState().forgeAuth[0].forge).toBe("GitLab (latest)");
  });

  it("clears the skeleton and keeps the fallback label when the whoami returns null", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "forge_auth_statuses") {
        return [
          { provider: "gitlab", forge: "GitLab", cli: "glab", authMethod: "GitLab CLI", available: true, authenticated: true, loginCommand: "x", docsUrl: "y", notes: "z" },
        ];
      }
      if (cmd === "forge_account") return null; // couldn't resolve
      return null;
    });
    useAccounts.setState({ forgeAuth: [], forgeAuthLoading: false, forgeAccountsLoading: [] });

    await useAccounts.getState().loadForgeAuth(true);
    await vi.waitFor(() => expect(useAccounts.getState().forgeAccountsLoading).toEqual([]));
    expect(useAccounts.getState().forgeAuth[0].account).toBeUndefined();
  });

  it("signOutForge calls the provider logout and force-refreshes status", async () => {
    let statusCalls = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "forge_sign_out") return "ok";
      if (cmd === "forge_auth_statuses") {
        statusCalls += 1;
        return [
          {
            provider: "gitlab",
            forge: "GitLab",
            cli: "glab",
            authMethod: "GitLab CLI",
            available: true,
            authenticated: false,
            loginCommand: "x",
            docsUrl: "y",
            notes: "z",
          },
        ];
      }
      return null;
    });
    useAccounts.setState({
      forgeAuth: [
        {
          provider: "gitlab",
          forge: "GitLab",
          cli: "glab",
          authMethod: "GitLab CLI",
          available: true,
          authenticated: true,
          loginCommand: "x",
          docsUrl: "y",
          notes: "z",
        },
      ],
      forgeAuthLoading: false,
      forgeAccountsLoading: [],
    });

    await useAccounts.getState().signOutForge("gitlab");

    expect(invokeMock).toHaveBeenCalledWith("forge_sign_out", { provider: "gitlab" });
    expect(statusCalls).toBe(1);
    expect(useAccounts.getState().forgeAuth[0].authenticated).toBe(false);
    expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toBe("Signed out of GitLab");
  });
});

describe("loadAccounts — PR fetch waits for remotes", () => {
  const apiAccount = {
    provider: "gh",
    host: "github.com",
    accountId: "1",
    login: "octocat",
    username: "octocat",
    name: "Octo Cat",
    email: "octo@example.com",
    id: 1,
    active: true,
    healthy: true,
    healthError: "",
  };

  it("does not foreground-fetch PRs before remotes have loaded", async () => {
    const loadPrs = vi.fn().mockResolvedValue(undefined);
    usePulls.setState({ loadPullRequests: loadPrs });
    useRepo.setState({ summary, remotes: [] });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "github_accounts") return [apiAccount];
      return null;
    });

    await useAccounts.getState().loadAccounts();

    expect(loadPrs).not.toHaveBeenCalled();
  });

  it("foreground-fetches PRs when remotes are already available", async () => {
    const loadPrs = vi.fn().mockResolvedValue(undefined);
    usePulls.setState({ loadPullRequests: loadPrs });
    useRepo.setState({ summary, remotes: [origin] });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "github_accounts") return [apiAccount];
      return null;
    });

    await useAccounts.getState().loadAccounts();

    expect(loadPrs).toHaveBeenCalledTimes(1);
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
      return null;
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
      return null;
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
      return null;
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
      return null;
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
      return null;
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
      return null;
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
    expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toBe("origin (and pull requests) use system git credentials");
  });

  it("setRepoAccount(null) also refreshes PRs when it clears a plain HTTPS default remote", async () => {
    localStorage.setItem("gitlane.repoAccounts", JSON.stringify({ [path]: { version: 2, ...account.ref } }));
    useRepo.setState({ summary, remotes: [originWithUser] });
    const loadPrs = vi.fn().mockResolvedValue(undefined);
    usePulls.setState({ loadPullRequests: loadPrs });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_remotes") return [origin];
      return null;
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
      return null;
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

describe("repository-identity keying across worktrees (GL-109)", () => {
  const mainPath = "/repo";
  const wtPath = "/repo/.claude/worktrees/lewin";
  const mainSummary: RepoSummary = {
    path: mainPath,
    workdir: mainPath,
    headBranch: "main",
    headOid: "abc",
    detached: false,
    isWorktree: false,
    mainPath: null,
  };
  const wtSummary: RepoSummary = {
    path: wtPath,
    workdir: wtPath,
    headBranch: "d/lewin",
    headOid: "abc",
    detached: false,
    isWorktree: true,
    mainPath,
  };

  it("an account bound in the main checkout applies in a linked worktree", async () => {
    useRepo.setState({ summary: mainSummary });
    useAccounts.getState().syncRepoAccount(mainPath);
    await useAccounts.getState().setRepoAccount(account.id);

    // Reopen the same repository through a linked worktree tab.
    useAccounts.setState({ repoAccountId: null, repoAccountRef: null });
    useRepo.setState({ summary: wtSummary });
    useAccounts.getState().syncRepoAccount(wtPath);

    expect(useAccounts.getState().repoAccountId).toBe(account.id);
    expect(useAccounts.getState().repoBindingKey).toBe(mainPath);
  });

  it("binding the PR account from a worktree persists under the repository identity", async () => {
    useRepo.setState({ summary: wtSummary, remotes: [] });
    useAccounts.getState().syncRepoAccount(wtPath);
    await useAccounts.getState().setRepoAccount(account.id);

    const stored = JSON.parse(localStorage.getItem("gitlane.repoAccounts") ?? "{}");
    // The PR-API account persists in the v2 shape (per-remote accounts are
    // git-native — see the gitcredentials describe above).
    expect(stored[mainPath]).toMatchObject({ version: 2, provider: "gh", accountId: "1" });
    expect(stored[wtPath]).toBeUndefined();
  });

  it("migrates a pre-identity binding stored under the worktree path", () => {
    // A binding persisted by a pre-GL-109 build, keyed by the worktree path.
    localStorage.setItem(
      "gitlane.repoAccounts",
      JSON.stringify({ [wtPath]: { version: 2, ...account.ref } }),
    );
    useRepo.setState({ summary: wtSummary });
    useAccounts.getState().syncRepoAccount(wtPath);

    expect(useAccounts.getState().repoAccountId).toBe(account.id);
    const stored = JSON.parse(localStorage.getItem("gitlane.repoAccounts") ?? "{}");
    expect(stored[mainPath]).toMatchObject({ version: 2, accountId: "1" });
    expect(stored[wtPath]).toBeUndefined();
  });

  it("derived per-remote accounts follow the remote list in any worktree", () => {
    const withUser = {
      name: "origin",
      fetchUrl: "https://octocat@github.com/owner/repo.git",
      pushUrl: "https://octocat@github.com/owner/repo.git",
      isDefault: true,
    };
    useRepo.setState({ summary: wtSummary, remotes: [withUser] });
    useAccounts.getState().syncRepoAccount(wtPath);

    // Derived from git config (the URL), so the worktree sees the same pick —
    // remotes are shared repo state, nothing app-side to migrate.
    expect(useAccounts.getState().repoRemoteAccountIds).toEqual({ origin: account.id });
    expect(useAccounts.getState().repoBindingKey).toBe(mainPath);
  });

  it("keeps the identity-keyed binding when a stale worktree shadow also exists", () => {
    // The identity entry (an explicit unbind) wins; the worktree shadow is dropped.
    localStorage.setItem(
      "gitlane.repoAccounts",
      JSON.stringify({
        [mainPath]: { version: 2, unbound: true },
        [wtPath]: { version: 2, ...account.ref },
      }),
    );
    useAccounts.setState({ activeAccountId: account.id });
    useRepo.setState({ summary: wtSummary });
    useAccounts.getState().syncRepoAccount(wtPath);

    expect(useAccounts.getState().repoAccountId).toBeNull();
    const stored = JSON.parse(localStorage.getItem("gitlane.repoAccounts") ?? "{}");
    expect(stored[mainPath]).toEqual({ version: 2, unbound: true });
    expect(stored[wtPath]).toBeUndefined();
  });
});

// prAccountRef() — the account ref the PR surface passes per forge (GL-140).
describe("prAccountRef — PR account resolution per forge", () => {
  const forge = (over: Partial<RepoForge>): RepoForge => ({
    hasRemote: true,
    kind: ForgeKind.GitLab,
    forge: "GitLab",
    host: "gitlab.com",
    webUrl: "https://gitlab.com/group/repo",
    ...over,
  });
  const glabRow: ForgeAuthStatus = {
    provider: "gitlab",
    forge: "GitLab",
    cli: "glab",
    authMethod: "GitLab CLI",
    available: true,
    authenticated: true,
    loginCommand: "glab auth login",
    docsUrl: "d",
    notes: "n",
  };
  const gitlabRemote = remoteInfo("origin", "https://gitlab.com/group/repo.git", true);
  const token: StoredProviderToken = {
    provider: "gitlab",
    credentialHost: "gitlab.com",
    accountId: "42",
    login: "ada",
    savedAt: 1,
  };

  it("returns the gh binding unchanged for a GitHub repo", () => {
    useRepo.setState({ forge: forge({ kind: ForgeKind.GitHub, forge: "GitHub", host: "github.com" }) });
    useAccounts.setState({ repoAccountRef: account.ref });
    expect(useAccounts.getState().prAccountRef()).toEqual(account.ref);
  });

  it("prefers glab (null ref) for a GitLab repo when glab is signed in", () => {
    useRepo.setState({ forge: forge({}), remotes: [gitlabRemote] });
    useAccounts.setState({ forgeAuth: [glabRow], providerTokens: {} });
    expect(useAccounts.getState().prAccountRef()).toBeNull();
  });

  it("uses a GitLab keychain-token account when glab isn't available", () => {
    useRepo.setState({ forge: forge({}), remotes: [gitlabRemote] });
    // No glab row → falls back to the stored token; keyed by host+login.
    useAccounts.setState({ forgeAuth: [], providerTokens: { "gitlab.com\u0000ada": token } });
    expect(useAccounts.getState().prAccountRef()).toEqual({
      provider: "native",
      host: "gitlab.com",
      accountId: "42",
      login: "ada",
    });
  });

  it("returns null for a GitLab repo with neither glab nor a token", () => {
    useRepo.setState({ forge: forge({}), remotes: [gitlabRemote] });
    useAccounts.setState({ forgeAuth: [], providerTokens: {} });
    expect(useAccounts.getState().prAccountRef()).toBeNull();
  });

  it("returns null for an unsupported forge", () => {
    useRepo.setState({ forge: forge({ kind: ForgeKind.Bitbucket, forge: "Bitbucket", host: "bitbucket.org" }) });
    expect(useAccounts.getState().prAccountRef()).toBeNull();
  });

  // gitlabPr() — readiness + display label for the GitLab PR account (GL-145).
  describe("gitlabPr", () => {
    it("is not-ready with no label for a GitHub repo", () => {
      useRepo.setState({ forge: forge({ kind: ForgeKind.GitHub, forge: "GitHub", host: "github.com" }) });
      expect(useAccounts.getState().gitlabPr()).toEqual({ ready: false, label: null });
    });

    it("is ready via glab, labelled from its whoami when known", () => {
      useRepo.setState({ forge: forge({}), remotes: [gitlabRemote] });
      useAccounts.setState({ forgeAuth: [{ ...glabRow, account: { username: "ada" } }], providerTokens: {} });
      expect(useAccounts.getState().gitlabPr()).toEqual({ ready: true, label: "@ada" });
    });

    it("is ready via glab with a bare 'glab' label when no whoami account", () => {
      useRepo.setState({ forge: forge({}), remotes: [gitlabRemote] });
      useAccounts.setState({ forgeAuth: [glabRow], providerTokens: {} });
      expect(useAccounts.getState().gitlabPr()).toEqual({ ready: true, label: "glab" });
    });

    it("is ready via a stored token, labelled with its login", () => {
      useRepo.setState({ forge: forge({}), remotes: [gitlabRemote] });
      useAccounts.setState({ forgeAuth: [], providerTokens: { "gitlab.com ada": token } });
      expect(useAccounts.getState().gitlabPr()).toEqual({ ready: true, label: "@ada" });
    });

    it("is not-ready with no label when neither glab nor a token is present", () => {
      useRepo.setState({ forge: forge({}), remotes: [gitlabRemote] });
      useAccounts.setState({ forgeAuth: [], providerTokens: {} });
      expect(useAccounts.getState().gitlabPr()).toEqual({ ready: false, label: null });
    });
  });
});

// A remote-auth mutation writes to the repo whose picker started it. When the
// user switches repos while the IPC write is in flight, the write and the
// durable binding must still land on the initiating repo, and the refresh /
// success toast / PR reload must NOT run against the newly-opened repo (GL-167).
describe("remote-auth mutations stay pinned to the initiating repo (GL-167)", () => {
  const otherSummary: RepoSummary = {
    path: "other-repo",
    workdir: "other-repo",
    headBranch: "main",
    headOid: "def",
    detached: false,
  };

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it("setRemoteAccount persists under the initiating repo and skips the other repo's refresh", async () => {
    useRepo.setState({ summary, remotes: [origin] });
    const loadPrs = vi.fn().mockResolvedValue(undefined);
    usePulls.setState({ loadPullRequests: loadPrs });
    const gate = deferred<null>();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "set_remote_username" ? gate.promise : Promise.resolve(null),
    );

    const run = useAccounts.getState().setRemoteAccount("origin", account.id);
    useRepo.setState({ summary: otherSummary, remotes: [] });
    gate.resolve(null);
    await run;

    // The write targeted the initiating repo…
    expect(invokeMock).toHaveBeenCalledWith("set_remote_username", {
      path,
      name: "origin",
      username: "octocat",
    });
    // …and the durable binding landed under ITS key, not the new repo's.
    const bindings = JSON.parse(localStorage.getItem("gitlane.repoAccounts") ?? "{}");
    expect(bindings[path]).toEqual({ version: 2, ...account.ref });
    expect(bindings["other-repo"]).toBeUndefined();
    // No refresh, PR reload, or success toast against the newly-opened repo.
    expect(invokeMock).not.toHaveBeenCalledWith("list_remotes", expect.anything());
    expect(loadPrs).not.toHaveBeenCalled();
    expect(useNotifications.getState().toasts).toEqual([]);
  });

  it("setRemoteUsername skips the refresh and toast after a mid-write repo switch", async () => {
    useRepo.setState({ summary, remotes: [origin] });
    const gate = deferred<null>();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "set_remote_username" ? gate.promise : Promise.resolve(null),
    );

    const run = useAccounts.getState().setRemoteUsername("origin", "alice");
    useRepo.setState({ summary: otherSummary, remotes: [] });
    gate.resolve(null);
    await run;

    expect(invokeMock).toHaveBeenCalledWith("set_remote_username", {
      path,
      name: "origin",
      username: "alice",
    });
    expect(invokeMock).not.toHaveBeenCalledWith("list_remotes", expect.anything());
    expect(useNotifications.getState().toasts).toEqual([]);
  });

  it("still surfaces a write failure's error toast after a mid-write repo switch", async () => {
    // Gating covers refreshes and SUCCESS toasts only — a failed write must
    // never be silent, whichever repo is open when it settles.
    useRepo.setState({ summary, remotes: [origin] });
    let reject!: (reason?: unknown) => void;
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "set_remote_username"
        ? new Promise((_res, rej) => {
            reject = rej;
          })
        : Promise.resolve(null),
    );

    const run = useAccounts.getState().setRemoteUsername("origin", "alice");
    useRepo.setState({ summary: otherSummary, remotes: [] });
    reject(new Error("remote write blew up"));
    await run;

    expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toContain("remote write blew up");
    expect(invokeMock).not.toHaveBeenCalledWith("list_remotes", expect.anything());
  });

  it("saveRemoteCredential uses Git's exact decoded Azure helper path", async () => {
    const azure = remoteInfo(
      "azure",
      "https://alex@dev.azure.com/contoso/My%20Project/_git/repo.git",
    );
    useRepo.setState({ summary, remotes: [azure] });
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "list_remotes" ? [azure] : null),
    );

    await expect(useAccounts.getState().saveRemoteCredential("azure", "alex", "tok")).resolves.toBe(
      true,
    );

    expect(invokeMock).toHaveBeenCalledWith("approve_https_credential", {
      credentialHost: "dev.azure.com",
      path: "contoso/My Project/_git/repo.git",
      username: "alex",
      password: "tok",
    });
  });

  it("saveRemoteCredential pins the username write to the initiating repo", async () => {
    useRepo.setState({ summary, remotes: [bucket] });
    const gate = deferred<null>();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "approve_https_credential" ? gate.promise : Promise.resolve(null),
    );

    const run = useAccounts.getState().saveRemoteCredential("bucket", "alice", "tok");
    useRepo.setState({ summary: otherSummary, remotes: [] });
    gate.resolve(null);
    await expect(run).resolves.toBe(true);

    // The credential save succeeded and the username pin hit the repo that
    // started the save — not whatever repo is open now.
    expect(invokeMock).toHaveBeenCalledWith("set_remote_username", {
      path,
      name: "bucket",
      username: "alice",
    });
    expect(invokeMock).not.toHaveBeenCalledWith("list_remotes", expect.anything());
    expect(useNotifications.getState().toasts).toEqual([]);
  });

  it("saveRemoteProviderToken keeps the token but pins the remote write to the initiating repo", async () => {
    useRepo.setState({ summary, remotes: [bucket] });
    const gate = deferred<null>();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "save_provider_token" ? gate.promise : Promise.resolve(null),
    );

    const run = useAccounts.getState().saveRemoteProviderToken("bucket", "alice", "tok");
    useRepo.setState({ summary: otherSummary, remotes: [] });
    gate.resolve(null);
    await run;

    // The keychain token metadata is app-global — it must survive the switch…
    expect(useAccounts.getState().hasProviderToken("bitbucket.org", "alice")).toBe(true);
    // …while the remote write stays pinned and the refresh/toast are skipped.
    expect(invokeMock).toHaveBeenCalledWith("set_remote_username", {
      path,
      name: "bucket",
      username: "alice",
    });
    expect(invokeMock).not.toHaveBeenCalledWith("list_remotes", expect.anything());
    expect(useNotifications.getState().toasts).toEqual([]);
  });
});

// App bootstrap and the Accounts panel refresh can run loadAccounts
// concurrently. Only the newest load may publish the list, its error, or the
// loading flag — an older response landing late must not overwrite a newer
// refresh/sign-out result, and its late failure must not clobber a success
// (GL-169; mirrors loadForgeAuth's generation).
describe("loadAccounts coalesces overlapping loads (GL-169)", () => {
  const ghAccount = (login: string) => ({
    provider: "gh",
    host: "github.com",
    accountId: login,
    login,
    username: login,
    name: login,
    email: `${login}@example.com`,
    id: 1,
    active: true,
    healthy: true,
    healthError: "",
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("an older load resolving late does not overwrite the newer load's list", async () => {
    // Remotes present + a stubbed PR loader, so the winner's PR-reload side
    // effect is observable and a stale load provably never re-triggers it.
    useRepo.setState({ summary, remotes: [origin] });
    const loadPrs = vi.fn().mockResolvedValue(undefined);
    usePulls.setState({ loadPullRequests: loadPrs });
    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    let call = 0;
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "github_accounts" ? [older, newer][call++].promise : Promise.resolve(null),
    );

    const loadA = useAccounts.getState().loadAccounts(); // bootstrap
    const loadB = useAccounts.getState().loadAccounts(); // settings refresh

    newer.resolve([ghAccount("fresh")]);
    await loadB;
    expect(useAccounts.getState().accounts.map((a) => a.login)).toEqual(["fresh"]);
    expect(useAccounts.getState().accountsLoading).toBe(false);
    expect(loadPrs).toHaveBeenCalledTimes(1);

    // The stale bootstrap snapshot lands afterwards → dropped, not published,
    // and none of the winner's side effects (repo sync / PR reload) re-run.
    older.resolve([ghAccount("stale")]);
    await loadA;
    expect(useAccounts.getState().accounts.map((a) => a.login)).toEqual(["fresh"]);
    expect(useAccounts.getState().accountsLoading).toBe(false);
    expect(useAccounts.getState().accountsError).toBeNull();
    expect(loadPrs).toHaveBeenCalledTimes(1);
  });

  it("a stale success does not resurrect the list after a newer load failed", async () => {
    // The sign-out shape: the post-sign-out refresh fails (gh unreachable), and
    // the pre-sign-out snapshot then resolves late with the old signed-in list.
    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    let call = 0;
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "github_accounts" ? [older, newer][call++].promise : Promise.resolve(null),
    );

    const loadA = useAccounts.getState().loadAccounts();
    const loadB = useAccounts.getState().loadAccounts();

    newer.reject(new Error("gh unreachable after sign-out"));
    await loadB;
    expect(useAccounts.getState().accountsError).toContain("gh unreachable");

    older.resolve([ghAccount("signed-out-user")]);
    await loadA;

    // The stale signed-in snapshot must not restore itself over the newer
    // load's outcome; the error (and the seeded list) stand.
    expect(useAccounts.getState().accounts.map((a) => a.login)).toEqual(["octocat"]);
    expect(useAccounts.getState().accountsError).toContain("gh unreachable");
    expect(useAccounts.getState().accountsLoading).toBe(false);
  });

  it("a superseded load's late failure does not clobber the newer result", async () => {
    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    let call = 0;
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "github_accounts" ? [older, newer][call++].promise : Promise.resolve(null),
    );

    const loadA = useAccounts.getState().loadAccounts();
    const loadB = useAccounts.getState().loadAccounts();

    newer.resolve([ghAccount("fresh")]);
    await loadB;

    older.reject(new Error("gh exploded on the stale request"));
    await loadA;

    // The successful newer list stays; no stale error, no stuck spinner.
    expect(useAccounts.getState().accounts.map((a) => a.login)).toEqual(["fresh"]);
    expect(useAccounts.getState().accountsError).toBeNull();
    expect(useAccounts.getState().accountsLoading).toBe(false);
  });
});
