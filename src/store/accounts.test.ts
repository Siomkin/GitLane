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
};

const identityCmds = (calls: unknown[][]) =>
  calls.filter(([cmd]) => cmd === "set_repo_identity" || cmd === "clear_repo_identity");

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
  useRepo.setState({ summary });
  useAccounts.setState({ accounts: [account], repoAccountId: null, repoAccountRef: null, repoIdentity: null });
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
