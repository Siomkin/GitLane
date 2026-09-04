import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForgeKind, type ForgeAuthStatus, type RepoForge, type RepoSummary } from "@/lib/api";
import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { useRepo } from "@/store/repo";
import { useAccounts, type Account, type StoredProviderToken } from "@/store/accounts";
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
