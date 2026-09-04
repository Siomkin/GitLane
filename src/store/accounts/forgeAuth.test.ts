import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CredentialSaveResult, type ProviderTokenStatus, type RepoSummary } from "@/lib/api";
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
      return emptyIpcPayload(cmd);
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
      return emptyIpcPayload(cmd);
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
      return emptyIpcPayload(cmd);
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
      return emptyIpcPayload(cmd);
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
      return emptyIpcPayload(cmd);
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
    expect(useNotifications.getState().toasts).toHaveLength(0);
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
      return emptyIpcPayload(cmd);
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
      return emptyIpcPayload(cmd);
    });

    await useAccounts.getState().loadAccounts();

    expect(loadPrs).toHaveBeenCalledTimes(1);
  });
});

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
    const gate = deferred<string>();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "set_remote_username" ? gate.promise : emptyIpcInvoke(cmd),
    );

    const run = useAccounts.getState().setRemoteAccount("origin", account.id);
    useRepo.setState({ summary: otherSummary, remotes: [] });
    gate.resolve("Updated origin.");
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
    const gate = deferred<string>();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "set_remote_username" ? gate.promise : emptyIpcInvoke(cmd),
    );

    const run = useAccounts.getState().setRemoteUsername("origin", "alice");
    useRepo.setState({ summary: otherSummary, remotes: [] });
    gate.resolve("Updated origin.");
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
        : emptyIpcInvoke(cmd),
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
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_remotes") return Promise.resolve([azure]);
      if (cmd === "approve_https_credential")
        return Promise.resolve({ username: "alex", helper: "manager" });
      return emptyIpcInvoke(cmd);
    });

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
    const gate = deferred<CredentialSaveResult>();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "approve_https_credential" ? gate.promise : emptyIpcInvoke(cmd),
    );

    const run = useAccounts.getState().saveRemoteCredential("bucket", "alice", "tok");
    useRepo.setState({ summary: otherSummary, remotes: [] });
    gate.resolve({ username: "alice", helper: "osxkeychain" });
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
    const gate = deferred<ProviderTokenStatus>();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "save_provider_token" ? gate.promise : emptyIpcInvoke(cmd),
    );

    const run = useAccounts.getState().saveRemoteProviderToken("bucket", "alice", "tok");
    useRepo.setState({ summary: otherSummary, remotes: [] });
    gate.resolve({
      provider: "bitbucket",
      host: "bitbucket.org",
      accountId: "alice",
      login: "alice",
      hasToken: true,
    });
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
      cmd === "github_accounts" ? [older, newer][call++].promise : emptyIpcInvoke(cmd),
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
      cmd === "github_accounts" ? [older, newer][call++].promise : emptyIpcInvoke(cmd),
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
      cmd === "github_accounts" ? [older, newer][call++].promise : emptyIpcInvoke(cmd),
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
