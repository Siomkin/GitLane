import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { RepoSummary } from "../lib/api";
import { useRepo } from "./repo";
import { useAccounts, type Account } from "./accounts";

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

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
  useRepo.setState({ summary });
  useAccounts.setState({
    accounts: [account],
    repoAccountId: null,
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

  it("binding from a worktree persists under the repository identity", async () => {
    useRepo.setState({ summary: wtSummary });
    useAccounts.getState().syncRepoAccount(wtPath);
    await useAccounts.getState().setRepoAccount(account.id);

    const stored = JSON.parse(localStorage.getItem("gitlane.repoAccounts") ?? "{}");
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
