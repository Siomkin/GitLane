// Per-remote account routing in the write actions (GL-129): every push-family
// call must send the account bound to the remote it actually targets.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { emptyAdvancedState } from "@/lib/advancedRepoState";
import type {
  BranchInfo,
  CommitNode,
  DiscardAllPreview,
  ForcePushPreview,
  GitTransportAuthRef,
  GithubAccountRef,
  RepoForge,
  RepoGraph,
  RepoSummary,
  WorkingChanges,
} from "@/lib/api";
import { ForgeKind } from "@/lib/api";
import { useAccounts, type Account } from "./accounts";
import { useNotifications } from "./notifications";
import { useRepo } from "./repo";

const HEAD_OID = "1111111";
const summary: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: HEAD_OID,
  detached: false,
};
const emptyGraph: RepoGraph = { commits: [], edges: [], laneCount: 1, head: null, truncated: false };
const EMPTY_CHANGES: WorkingChanges = {
  staged: [],
  unstaged: [],
  conflicted: [],
  advanced: emptyAdvancedState,
};
const FORCE_PUSH_PREVIEW: ForcePushPreview = {
  summary: "Force-push feat with lease",
  details: [],
  warnings: [],
  expectedOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  remote: "mirror",
  destinationRef: "refs/heads/review/feat",
  destinationOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  pushEndpointToken: "endpoint-token",
};
const DISCARD_ALL_PREVIEW: DiscardAllPreview = {
  summary: "Discard all changes with lease",
  details: ["src/a.ts"],
  warnings: ["Untracked files cannot be recovered"],
  expectedState: "discard-all-state-v1",
  expectedHeadBranch: "main",
  expectedHeadOid: HEAD_OID,
};

// Valid shapes for the reads a post-action refresh performs (GL-57 seam validation).
const refreshInvoke = (cmd: string) => {
  switch (cmd) {
    case "open_repo":
      return Promise.resolve(summary);
    case "commit_graph":
      return Promise.resolve(emptyGraph);
    case "working_changes":
      return Promise.resolve(EMPTY_CHANGES);
    default:
      return Promise.resolve([]);
  }
};

const mkAccount = (accountId: string, login: string, host = "github.com"): Account => {
  const ref: GithubAccountRef = { provider: "gh", host, accountId, login };
  return {
    id: `gh:${host}:${accountId}`,
    forge: "GitHub",
    provider: "gh",
    host,
    accountId,
    login,
    label: login,
    username: login,
    name: login,
    email: `${login}@example.com`,
    color: "#5b8def",
    ref,
    active: false,
    healthy: true,
    healthError: "",
  };
};
const alice = mkAccount("1", "alice");
const bob = mkAccount("2", "bob");
const ghAuth = (account: Account): GitTransportAuthRef => ({
  mode: "githubGh",
  provider: "github",
  host: account.host,
  credentialHost: account.host,
  username: account.login,
  accountRef: account.ref,
});
const bucketAuth: GitTransportAuthRef = {
  mode: "credentialHelper",
  provider: "bitbucket",
  host: "bitbucket.org",
  credentialHost: "bitbucket.org",
  username: "alice",
};

const remote = (name: string, url: string, isDefault = false) => ({
  name,
  fetchUrl: url,
  pushUrl: url,
  isDefault,
});
const branch = (over: Partial<BranchInfo>): BranchInfo => ({
  name: "main",
  kind: "local",
  target: HEAD_OID,
  isHead: false,
  upstream: null,
  remote: null,
  upstreamRemote: null,
  pushRemote: null,
  sync: null,
  ...over,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const commitNode = (id: string): CommitNode => ({
  id,
  shortId: id,
  summary: id,
  body: "",
  authorName: "Test",
  authorEmail: "test@example.com",
  timestamp: 1,
  parents: [],
  lane: 0,
  row: 0,
  color: 0,
  refs: [],
});

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(refreshInvoke);
  useNotifications.setState({ toasts: [] });
  useRepo.setState({
    summary,
    remotes: [
      remote("origin", "https://alice@github.com/owner/repo.git", true),
      remote("mirror", "https://bob@github.com/owner/mirror.git"),
      remote("bucket", "https://alice@bitbucket.org/team/repo.git"),
    ],
    branches: [
      branch({ name: "main", isHead: true, upstreamRemote: "mirror" }),
      branch({ name: "feat", upstreamRemote: null }),
    ],
    loading: false,
    netOps: 0,
    fetchingPath: null,
  });
  useAccounts.setState({
    accounts: [alice, bob],
    repoRemoteAccountIds: { origin: alice.id, mirror: bob.id, bucket: null },
    repoAccountId: alice.id,
    repoAccountRef: alice.ref,
  });
});

describe("fetch — per-remote transport auth pairs", () => {
  it("sends one {remote, auth} pair per URL-bound remote", async () => {
    await useRepo.getState().fetch();

    expect(invokeMock).toHaveBeenCalledWith("fetch", {
      path: "/repo",
      remoteAccounts: [
        { remote: "origin", auth: ghAuth(alice) },
        { remote: "mirror", auth: ghAuth(bob) },
        { remote: "bucket", auth: bucketAuth },
      ],
    });
  });

  it("routes fetch and pull to the fetch authority while push uses the push authority", async () => {
    const fetchAccount = mkAccount("fetch-account", "fetch-user", "fetch.github.com");
    const pushAccount = mkAccount("push-account", "push-user", "push.github.com");
    const splitRemote = {
      name: "origin",
      fetchUrl: "https://fetch-user@fetch.github.com/owner/repo.git",
      pushUrl: "https://push-user@push.github.com/owner/repo.git",
      isDefault: true,
    };
    const splitBranch = branch({
      name: "main",
      isHead: true,
      upstream: "origin/main",
      upstreamRemote: "origin",
      pushRemote: "origin",
    });
    const resetSplitRepo = () => {
      useRepo.setState({ remotes: [splitRemote], branches: [splitBranch] });
      useAccounts.setState({
        accounts: [fetchAccount, pushAccount],
        repoRemoteAccountIds: {},
        repoAccountId: null,
        repoAccountRef: null,
      });
    };

    resetSplitRepo();
    await useRepo.getState().fetch({ quiet: true });
    expect(invokeMock).toHaveBeenCalledWith("fetch", {
      path: "/repo",
      remoteAccounts: [{ remote: "origin", auth: ghAuth(fetchAccount) }],
    });

    resetSplitRepo();
    await useRepo.getState().pull();
    expect(invokeMock).toHaveBeenCalledWith("pull", {
      path: "/repo",
      branch: "main",
      expectedOid: HEAD_OID,
      auth: ghAuth(fetchAccount),
    });

    resetSplitRepo();
    await useRepo.getState().push();
    expect(invokeMock).toHaveBeenCalledWith("push_branch", {
      path: "/repo",
      branch: "main",
      expectedOid: HEAD_OID,
      auth: ghAuth(pushAccount),
    });
  });
});

describe("fetch — quiet mode (auto-fetch, GL-221)", () => {
  it("succeeds with no toasts, skips the foreground refresh, and preserves unrelated error state", async () => {
    useRepo.setState({ error: "pre-existing read error" });

    const ok = await useRepo.getState().fetch({ quiet: true });

    expect(ok).toBe(true);
    expect(useNotifications.getState().toasts).toHaveLength(0);
    // No foreground refresh: the graph reload is the refresh's signature read —
    // the watcher's own quiet re-sync picks up the fetched refs instead.
    expect(invokeMock).not.toHaveBeenCalledWith("commit_graph", expect.anything());
    expect(useRepo.getState().loading).toBe(false);
    // Quiet mode must not clear an error it didn't cause.
    expect(useRepo.getState().error).toBe("pre-existing read error");
  });

  it("returns false on failure without surfacing any toast or touching error state", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    useRepo.setState({ error: "pre-existing read error" });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "fetch" ? Promise.reject("auth failed") : refreshInvoke(cmd),
    );

    const ok = await useRepo.getState().fetch({ quiet: true });

    expect(ok).toBe(false);
    expect(useNotifications.getState().toasts).toHaveLength(0);
    expect(useRepo.getState().loading).toBe(false);
    expect(useRepo.getState().error).toBe("pre-existing read error");
    warnSpy.mockRestore();
  });

  it("holds netOps and the visible fetch owner — but never `loading` — while on the wire", async () => {
    let netOpsDuring = -1;
    let loadingDuring = true;
    let fetchingPathDuring: string | null = null;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "fetch") {
        netOpsDuring = useRepo.getState().netOps;
        loadingDuring = useRepo.getState().loading;
        fetchingPathDuring = useRepo.getState().fetchingPath;
        return Promise.resolve(null);
      }
      return refreshInvoke(cmd);
    });

    const ok = await useRepo.getState().fetch({ quiet: true });

    expect(ok).toBe(true);
    expect(netOpsDuring).toBe(1);
    // The app shell stays usable; fetchingPath drives only the network controls.
    expect(loadingDuring).toBe(false);
    expect(fetchingPathDuring).toBe("/repo");
    expect(useRepo.getState().netOps).toBe(0);
    expect(useRepo.getState().fetchingPath).toBeNull();
  });

  it("coalesces a manual fetch onto an automatic fetch already updating refs", async () => {
    let resolveFetch!: () => void;
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "fetch"
        ? new Promise<void>((resolve) => {
            resolveFetch = resolve;
          })
        : refreshInvoke(cmd),
    );

    const automatic = useRepo.getState().fetch({ quiet: true });
    expect(useRepo.getState().fetchingPath).toBe("/repo");
    const manual = useRepo.getState().fetch();

    await vi.waitFor(() => {
      expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "fetch")).toHaveLength(1);
    });
    resolveFetch();

    await expect(Promise.all([automatic, manual])).resolves.toEqual([true, true]);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "fetch")).toHaveLength(1);
    expect(useRepo.getState().fetchingPath).toBeNull();
  });

  it("refuses pull and push from any caller while fetch owns the transport mutex", async () => {
    let resolveFetch!: () => void;
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "fetch"
        ? new Promise<void>((resolve) => {
            resolveFetch = resolve;
          })
        : refreshInvoke(cmd),
    );

    const automatic = useRepo.getState().fetch({ quiet: true });
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("fetch", expect.anything()));

    const notificationSnapshots: string[][] = [];
    const unsubscribe = useNotifications.subscribe((state) => {
      notificationSnapshots.push(state.toasts.map((toast) => toast.kind));
    });
    await Promise.all([useRepo.getState().pull(), useRepo.getState().push()]);
    unsubscribe();

    expect(invokeMock).not.toHaveBeenCalledWith("pull", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("push_branch", expect.anything());
    expect(notificationSnapshots.some((kinds) => kinds.includes("progress"))).toBe(false);
    expect(useNotifications.getState().toasts).toHaveLength(2);
    for (const toast of useNotifications.getState().toasts) {
      expect(toast.kind).toBe("error");
      expect(toast.title).toContain("Another remote operation is already in progress");
    }

    resolveFetch();
    await expect(automatic).resolves.toBe(true);
  });
});

describe("fetch / pull — progress toast → success (or dropped on error)", () => {
  it("fetch resolves into a Fetched success with the new-commit count", async () => {
    // Single remote → named title; the post-fetch branch read reports the
    // tracked branch fell 2 behind (i.e. 2 commits were fetched).
    useRepo.setState({
      remotes: [remote("origin", "https://alice@github.com/owner/repo.git", true)],
      branches: [branch({ name: "main", isHead: true, upstreamRemote: "origin", sync: null })],
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "list_branches"
        ? Promise.resolve([
            branch({
              name: "main",
              isHead: true,
              upstreamRemote: "origin",
              sync: { status: "behind", upstream: "origin/main", ahead: 0, behind: 2 },
            }),
          ])
        : refreshInvoke(cmd),
    );

    await useRepo.getState().fetch();

    const toast = useNotifications.getState().toasts.slice(-1)[0];
    expect(toast?.kind).toBe("success");
    expect(toast?.title).toBe("Fetched origin");
    expect(toast?.body).toBe("↓2 new commits on main");
    expect(toast?.duration).toBe(5000);
  });

  it("fetch drops its progress toast and shows an error on failure", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "fetch" ? Promise.reject("network down") : refreshInvoke(cmd),
    );

    await useRepo.getState().fetch();

    const toasts = useNotifications.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("error");
    expect(toasts[0].title).toContain("network down");
  });

  it("pull reports Pulled changes when the branch tip advances", async () => {
    useRepo.setState({
      branches: [
        branch({ name: "main", isHead: true, upstreamRemote: "mirror", upstream: "mirror/main", target: "aaaa" }),
      ],
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "list_branches"
        ? Promise.resolve([
            branch({ name: "main", isHead: true, upstreamRemote: "mirror", upstream: "mirror/main", target: "bbbb" }),
          ])
        : refreshInvoke(cmd),
    );

    await useRepo.getState().pull();

    const toast = useNotifications.getState().toasts.slice(-1)[0];
    expect(toast?.kind).toBe("success");
    expect(toast?.title).toBe("Pulled changes");
    expect(toast?.body).toBe("from mirror/main");
  });

  it("pull reports up to date when the tip is unchanged", async () => {
    useRepo.setState({
      branches: [
        branch({ name: "main", isHead: true, upstreamRemote: "mirror", upstream: "mirror/main", target: "aaaa" }),
      ],
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "list_branches"
        ? Promise.resolve([
            branch({ name: "main", isHead: true, upstreamRemote: "mirror", upstream: "mirror/main", target: "aaaa" }),
          ])
        : refreshInvoke(cmd),
    );

    await useRepo.getState().pull();

    const toast = useNotifications.getState().toasts.slice(-1)[0];
    expect(toast?.title).toBe("Already up to date");
    expect(toast?.body).toBe("main is up to date");
  });

  it("fetch reports 'No new commits' when nothing new arrived (still may be behind)", async () => {
    useRepo.setState({
      remotes: [remote("origin", "https://alice@github.com/owner/repo.git", true)],
      branches: [branch({ name: "main", isHead: true, upstreamRemote: "origin", sync: null })],
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "list_branches"
        ? Promise.resolve([
            branch({
              name: "main",
              isHead: true,
              upstreamRemote: "origin",
              sync: { status: "upToDate", upstream: "origin/main", ahead: 0, behind: 0 },
            }),
          ])
        : refreshInvoke(cmd),
    );

    await useRepo.getState().fetch();

    const toast = useNotifications.getState().toasts.slice(-1)[0];
    expect(toast?.title).toBe("Fetched origin");
    expect(toast?.body).toBe("No new commits");
  });

  it("keeps the fetch success toast when the post-fetch refresh fails", async () => {
    // The REAL refresh runs and fails on its graph read — it never rejects, it
    // resolves false — so this exercises the production contract, not a mock's.
    useRepo.setState({
      remotes: [remote("origin", "https://alice@github.com/owner/repo.git", true)],
      branches: [branch({ name: "main", isHead: true, upstreamRemote: "origin", sync: null })],
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "commit_graph" ? Promise.reject("graph read failed") : refreshInvoke(cmd),
    );

    await useRepo.getState().fetch();

    const toasts = useNotifications.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("success");
    expect(toasts[0].title).toBe("Fetched origin");
    // Refresh failed → drop the (now-untrustworthy) count rather than claim
    // "No new commits".
    expect(toasts[0].body).toBeUndefined();
  });

  it("a fetch that outlives a repo switch leaves the new repo's lifecycle alone", async () => {
    const otherSummary = { ...summary, path: "/other", workdir: "/other" };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "fetch") {
        // A repo switch lands while the fetch is on the wire: the new repo's
        // load owns `loading` now.
        useRepo.setState({ summary: otherSummary, loading: true });
        return Promise.resolve(null);
      }
      return refreshInvoke(cmd);
    });

    const ok = await useRepo.getState().fetch();

    expect(ok).toBe(true);
    // The stale completion must not clear the new repo's loading or refresh it
    // (commit_graph is the refresh's signature read).
    expect(useRepo.getState().loading).toBe(true);
    expect(invokeMock).not.toHaveBeenCalledWith("commit_graph", expect.anything());
    // The toast still resolves — the fetch did succeed — but without a count
    // read from the wrong repo's branches.
    const toast = useNotifications.getState().toasts.slice(-1)[0];
    expect(toast?.kind).toBe("success");
    expect(toast?.body).toBeUndefined();
  });

  it("keeps the pull success toast when the post-pull refresh fails", async () => {
    // Real refresh, real failure (see the fetch twin above).
    useRepo.setState({
      branches: [
        branch({ name: "main", isHead: true, upstreamRemote: "mirror", upstream: "mirror/main", target: "aaaa" }),
      ],
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "commit_graph" ? Promise.reject("graph read failed") : refreshInvoke(cmd),
    );

    await useRepo.getState().pull();

    const toasts = useNotifications.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("success");
    // Refresh failed → neutral "Pulled", never a stale "Already up to date".
    expect(toasts[0].title).toBe("Pulled");
  });

  it("a pull that outlives a repo switch resolves neutrally and leaves the new repo alone", async () => {
    useRepo.setState({
      branches: [
        branch({ name: "main", isHead: true, upstreamRemote: "mirror", upstream: "mirror/main", target: "aaaa" }),
      ],
    });
    const otherSummary = { ...summary, path: "/other", workdir: "/other" };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "pull") {
        // A repo switch lands while the pull is on the wire.
        useRepo.setState({ summary: otherSummary, loading: true });
        return Promise.resolve(null);
      }
      return refreshInvoke(cmd);
    });

    await useRepo.getState().pull();

    // No refresh against the new checkout, and its loading is untouched.
    expect(useRepo.getState().loading).toBe(true);
    expect(invokeMock).not.toHaveBeenCalledWith("commit_graph", expect.anything());
    const toast = useNotifications.getState().toasts.slice(-1)[0];
    expect(toast?.kind).toBe("success");
    // Neutral title: the tip comparison would read the wrong repo's branches.
    expect(toast?.title).toBe("Pulled");
  });
});

describe("refresh — explicit success result", () => {
  it("resolves true on a full refresh and false when a read fails", async () => {
    await expect(useRepo.getState().refresh()).resolves.toBe(true);

    invokeMock.mockImplementation((cmd: string) =>
      cmd === "commit_graph" ? Promise.reject("graph read failed") : refreshInvoke(cmd),
    );
    await expect(useRepo.getState().refresh()).resolves.toBe(false);
  });

  it("resolves false when no repository is open", async () => {
    useRepo.setState({ summary: null });
    await expect(useRepo.getState().refresh()).resolves.toBe(false);
  });
});

describe("push family — the target remote's account, not a repo-wide one", () => {
  it("pull sends the head branch's upstream remote auth", async () => {
    await useRepo.getState().pull();

    expect(invokeMock).toHaveBeenCalledWith("pull", {
      path: "/repo",
      branch: "main",
      expectedOid: HEAD_OID,
      auth: ghAuth(bob),
    });
  });

  it("push sends the explicit head branch and its push-remote account", async () => {
    await useRepo.getState().push();

    // Head branch `main` pushes to `mirror`, bound to bob — not the default
    // remote's alice.
    expect(invokeMock).toHaveBeenCalledWith("push_branch", {
      path: "/repo",
      branch: "main",
      expectedOid: HEAD_OID,
      auth: ghAuth(bob),
    });
  });

  it("resolves the push progress toast into a success card with commit count + View action", async () => {
    const forge: RepoForge = {
      hasRemote: true,
      kind: ForgeKind.GitHub,
      forge: "GitHub",
      host: "github.com",
      webUrl: "https://github.com/owner/mirror",
    };
    useRepo.setState({
      branches: [
        branch({
          name: "main",
          isHead: true,
          upstreamRemote: "mirror",
          sync: { status: "ahead", upstream: "mirror/main", ahead: 3, behind: 0 },
        }),
      ],
      forge,
    });

    await useRepo.getState().push();

    const toast = useNotifications.getState().toasts.slice(-1)[0];
    expect(toast?.kind).toBe("success");
    expect(toast?.title).toBe("Pushed 3 commits");
    expect(toast?.body).toBe("to mirror/main");
    expect(toast?.duration).toBe(5000);
    expect(toast?.actions?.[0]?.label).toBe("View on GitHub");
  });

  it("labels a local-repository push without origin auth or a forge link", async () => {
    const forge: RepoForge = {
      hasRemote: true,
      kind: ForgeKind.GitHub,
      forge: "GitHub",
      host: "github.com",
      webUrl: "https://github.com/owner/repo",
    };
    useRepo.setState({
      branches: [
        branch({
          name: "feature",
          isHead: true,
          upstream: "shared",
          upstreamRemote: ".",
          pushRemote: ".",
          sync: { status: "ahead", upstream: "shared", ahead: 2, behind: 0 },
        }),
      ],
      forge,
    });

    await useRepo.getState().push();

    expect(invokeMock).toHaveBeenCalledWith("push_branch", {
      path: "/repo",
      branch: "feature",
      expectedOid: HEAD_OID,
      auth: null,
    });
    const toast = useNotifications.getState().toasts.slice(-1)[0];
    expect(toast?.title).toBe("Pushed 2 commits");
    expect(toast?.body).toBe("to local branch shared");
    expect(toast?.actions).toBeUndefined();
  });

  it("drops the progress toast and surfaces an error toast when the push fails", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "push_branch" ? Promise.reject("remote rejected") : refreshInvoke(cmd),
    );

    await useRepo.getState().push();

    const toasts = useNotifications.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("error");
    expect(toasts[0].title).toContain("remote rejected");
  });

  it("labels the push success with the upstream branch name, not the local name", async () => {
    const forge: RepoForge = {
      hasRemote: true,
      kind: ForgeKind.GitHub,
      forge: "GitHub",
      host: "github.com",
      webUrl: "https://github.com/owner/repo",
    };
    useRepo.setState({
      remotes: [remote("origin", "https://alice@github.com/owner/repo.git", true)],
      branches: [
        branch({
          name: "feature-x",
          isHead: true,
          upstreamRemote: "origin",
          upstream: "origin/main",
          sync: { status: "ahead", upstream: "origin/main", ahead: 1, behind: 0 },
        }),
      ],
      forge,
    });

    await useRepo.getState().push();

    const toast = useNotifications.getState().toasts.slice(-1)[0];
    expect(toast?.title).toBe("Pushed 1 commit");
    // "origin/main" (the upstream), not the local "feature-x".
    expect(toast?.body).toBe("to origin/main");
    expect(toast?.actions?.[0]?.label).toBe("View on GitHub");
  });

  it("keeps the push success toast when the post-push refresh fails", async () => {
    // Real refresh, real failure — refresh resolves false, never rejects.
    useRepo.setState({
      branches: [
        branch({
          name: "main",
          isHead: true,
          upstreamRemote: "mirror",
          sync: { status: "ahead", upstream: "mirror/main", ahead: 2, behind: 0 },
        }),
      ],
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "commit_graph" ? Promise.reject("graph read failed") : refreshInvoke(cmd),
    );

    await useRepo.getState().push();

    const toasts = useNotifications.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("success");
    expect(toasts[0].title).toBe("Pushed 2 commits");
  });

  it("pushBranch resolves the named branch's remote (origin fallback)", async () => {
    await useRepo.getState().pushBranch("feat");

    expect(invokeMock).toHaveBeenCalledWith("push_branch", {
      path: "/repo",
      branch: "feat",
      expectedOid: HEAD_OID,
      auth: ghAuth(alice),
    });
  });

  it("publishBranch picks the account of the upstream's remote", async () => {
    await useRepo.getState().publishBranch("feat", "bucket/feat");

    // bucket is Bitbucket → URL username plus system credential helper.
    expect(invokeMock).toHaveBeenCalledWith("publish_branch", {
      path: "/repo",
      branch: "feat",
      expectedOid: HEAD_OID,
      upstream: "bucket/feat",
      auth: bucketAuth,
    });
  });

  it("forcePush passes the previewed source, route, and lease without recomputing them", async () => {
    await useRepo.getState().forcePush("feat", FORCE_PUSH_PREVIEW);

    expect(invokeMock).toHaveBeenCalledWith("force_push", {
      path: "/repo",
      branch: "feat",
      expectedOid: FORCE_PUSH_PREVIEW.expectedOid,
      remote: FORCE_PUSH_PREVIEW.remote,
      destinationRef: FORCE_PUSH_PREVIEW.destinationRef,
      destinationOid: FORCE_PUSH_PREVIEW.destinationOid,
      pushEndpointToken: FORCE_PUSH_PREVIEW.pushEndpointToken,
      auth: ghAuth(bob),
    });
  });

  it("deleteRemoteBranch uses the explicit remote's account", async () => {
    await useRepo.getState().deleteRemoteBranch("mirror", "feat", HEAD_OID);

    expect(invokeMock).toHaveBeenCalledWith("delete_remote_branch", {
      path: "/repo",
      remote: "mirror",
      branch: "feat",
      expectedOid: HEAD_OID,
      auth: ghAuth(bob),
    });
  });
});

describe("tags — explicit or default remote, with its account", () => {
  it("pushTag targets the picked remote", async () => {
    await useRepo.getState().pushTag("v1.0.0", "mirror");

    expect(invokeMock).toHaveBeenCalledWith("push_tag", {
      path: "/repo",
      name: "v1.0.0",
      remote: "mirror",
      auth: ghAuth(bob),
    });
  });

  it("pushTag falls back to the default remote", async () => {
    await useRepo.getState().pushTag("v1.0.0");

    expect(invokeMock).toHaveBeenCalledWith("push_tag", {
      path: "/repo",
      name: "v1.0.0",
      remote: "origin",
      auth: ghAuth(alice),
    });
  });

  it("deleteTag(alsoRemote) deletes on the default remote and names it in the toast", async () => {
    const message = await useRepo.getState().deleteTag("v1.0.0", "tag-object-1", true);

    expect(invokeMock).toHaveBeenCalledWith("delete_remote_tag", {
      path: "/repo",
      name: "v1.0.0",
      expectedOid: "tag-object-1",
      remote: "origin",
      auth: ghAuth(alice),
    });
    expect(message).toBe("Deleted tag v1.0.0 (local and origin)");
  });
});

describe("discard all — exact preview lease and partial-failure recovery", () => {
  const dirtyChanges: WorkingChanges = {
    staged: [],
    unstaged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
    conflicted: [],
    advanced: emptyAdvancedState,
  };

  it("passes every preview lease field to the destructive IPC", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "discard_all" ? Promise.resolve("Discarded all changes") : refreshInvoke(cmd),
    );

    await useRepo.getState().discardAll(DISCARD_ALL_PREVIEW);

    expect(invokeMock).toHaveBeenCalledWith("discard_all", {
      path: "/repo",
      expectedState: "discard-all-state-v1",
      expectedHeadBranch: "main",
      expectedHeadOid: HEAD_OID,
    });
  });

  it("rejects an in-cone sparse checkout before destructive IPC", async () => {
    useRepo.setState({
      changes: {
        staged: [],
        unstaged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
        conflicted: [],
        advanced: {
          submodules: [],
          lfs: { detected: false, installed: null, issues: [], patterns: [] },
          sparseCheckout: { enabled: true, mode: "cone", patterns: ["src/"] },
        },
      },
    });

    await expect(useRepo.getState().discardAll(DISCARD_ALL_PREVIEW)).rejects.toThrow(
      "Sparse checkout is enabled. Disable sparse checkout before using Discard all, or use the terminal.",
    );
    expect(invokeMock).not.toHaveBeenCalledWith("discard_all", expect.anything());
  });

  it("rejects an unborn repository before destructive IPC", async () => {
    useRepo.setState({
      summary: { ...useRepo.getState().summary!, headOid: null, unborn: true },
      changes: dirtyChanges,
    });

    await expect(useRepo.getState().discardAll(DISCARD_ALL_PREVIEW)).rejects.toThrow(
      "Discard all is unavailable before the first commit. Unstage or remove files individually, or use the terminal.",
    );
    expect(invokeMock).not.toHaveBeenCalledWith("discard_all", expect.anything());
  });

  it("refreshes state after the backend reports a post-clean failure", async () => {
    const postCleanError =
      "Untracked cleanup completed, but tracked changes could not be reset: reset failed";
    useRepo.setState({ changes: dirtyChanges });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "discard_all") return Promise.reject(postCleanError);
      return refreshInvoke(cmd);
    });

    await expect(useRepo.getState().discardAll(DISCARD_ALL_PREVIEW)).rejects.toBe(postCleanError);

    expect(invokeMock).toHaveBeenCalledWith("working_changes", { path: "/repo" });
    expect(useRepo.getState().changes).toEqual(EMPTY_CHANGES);
  });

  it("preserves a stale-precondition error even if its reconciliation refresh rejects", async () => {
    const staleError =
      "Working tree changed after the confirmation opened. Refresh and try again.";
    const refreshError = new Error("refresh contract failure");
    const realRefresh = useRepo.getState().refresh;
    const refresh = vi.fn().mockRejectedValue(refreshError);
    useRepo.setState({ refresh });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "discard_all" ? Promise.reject(staleError) : refreshInvoke(cmd),
    );

    try {
      await expect(useRepo.getState().discardAll(DISCARD_ALL_PREVIEW)).rejects.toBe(staleError);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      useRepo.setState({ refresh: realRefresh });
    }
  });
});

describe("write completions — published repo and navigation ownership", () => {
  const raceGraph: RepoGraph = {
    commits: [commitNode("a"), commitNode("b")],
    edges: [],
    laneCount: 1,
    head: "a",
    truncated: false,
  };
  const raceInvoke = (cmd: string, args?: { path?: string }) => {
    switch (cmd) {
      case "open_repo": {
        const path = args?.path ?? "/repo";
        return Promise.resolve({ ...summary, path, workdir: path });
      }
      case "commit_graph":
        return Promise.resolve(raceGraph);
      case "list_branches":
        return Promise.resolve([
          branch({ name: "main", isHead: true, upstream: "origin/main", upstreamRemote: "origin" }),
        ]);
      case "working_changes":
        return Promise.resolve(EMPTY_CHANGES);
      case "commit_files":
      case "list_worktrees":
        return Promise.resolve([]);
      case "repo_file_text":
        return Promise.resolve({
          text: "base\n",
          size: 5,
          truncated: false,
          binary: false,
          expectedState: "lease",
        });
      case "repo_file_head_text":
        return Promise.resolve("base\n");
      default:
        return refreshInvoke(cmd);
    }
  };
  const changedFile = {
    path: "src/a.ts",
    status: "M" as const,
    add: 1,
    del: 0,
    binary: false,
  };
  const prepareRaceRepo = () => {
    useRepo.setState({
      summary,
      openPaths: [summary.path],
      graph: raceGraph,
      changes: {
        staged: [],
        unstaged: [changedFile],
        conflicted: [],
        advanced: emptyAdvancedState,
      },
      selectedCommit: "a",
      selectedCommits: ["a"],
      selectionAnchor: "a",
      selectedFile: { path: changedFile.path, source: "unstaged" },
      fileSelectionRequestId: 0,
      fileView: null,
      loading: false,
    });
  };

  it("drops a delayed stage completion after A → B", async () => {
    const stageGate = deferred<void>();
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) =>
      cmd === "stage_file" ? stageGate.promise : raceInvoke(cmd, args),
    );
    prepareRaceRepo();
    const realSelectFile = useRepo.getState().selectFile;
    const selectFile = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ selectFile });

    try {
      const stage = useRepo.getState().stageFile(changedFile.path);
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("stage_file", expect.anything()));
      await useRepo.getState().loadRepo("/other");
      invokeMock.mockClear();

      stageGate.resolve(undefined);
      await stage;

      expect(invokeMock).not.toHaveBeenCalledWith("commit_graph", expect.anything());
      expect(selectFile).not.toHaveBeenCalled();
      expect(useRepo.getState().summary?.path).toBe("/other");
    } finally {
      useRepo.setState({ selectFile: realSelectFile });
    }
  });

  it("drops a delayed stage completion after A → B → A reopens the same path", async () => {
    const stageGate = deferred<void>();
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) =>
      cmd === "stage_file" ? stageGate.promise : raceInvoke(cmd, args),
    );
    prepareRaceRepo();
    const realSelectFile = useRepo.getState().selectFile;
    const selectFile = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ selectFile });

    try {
      const stage = useRepo.getState().stageFile(changedFile.path);
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("stage_file", expect.anything()));
      await useRepo.getState().loadRepo("/other");
      await useRepo.getState().loadRepo("/repo");
      invokeMock.mockClear();

      stageGate.resolve(undefined);
      await stage;

      expect(invokeMock).not.toHaveBeenCalledWith("commit_graph", expect.anything());
      expect(selectFile).not.toHaveBeenCalled();
      expect(useRepo.getState().summary?.path).toBe("/repo");
    } finally {
      useRepo.setState({ selectFile: realSelectFile });
    }
  });

  it("rejects a write started during a pending same-path reopen once that session publishes", async () => {
    const reopenGate = deferred<RepoSummary>();
    const stageGate = deferred<void>();
    let firstOpen = true;
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "open_repo" && firstOpen) {
        firstOpen = false;
        return reopenGate.promise;
      }
      if (cmd === "stage_file") return stageGate.promise;
      return raceInvoke(cmd, args);
    });
    prepareRaceRepo();
    const realSelectFile = useRepo.getState().selectFile;
    const selectFile = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ selectFile });

    try {
      const reopening = useRepo.getState().loadRepo("/repo");
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("open_repo", { path: "/repo" }));
      const stage = useRepo.getState().stageFile(changedFile.path);
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("stage_file", expect.anything()));

      reopenGate.resolve(summary);
      await reopening;
      invokeMock.mockClear();
      stageGate.resolve(undefined);
      await stage;

      expect(invokeMock).not.toHaveBeenCalledWith("commit_graph", expect.anything());
      expect(selectFile).not.toHaveBeenCalled();
    } finally {
      useRepo.setState({ selectFile: realSelectFile });
    }
  });

  it("does not let a delayed stage override a newer commit selection", async () => {
    const stageGate = deferred<void>();
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) =>
      cmd === "stage_file" ? stageGate.promise : raceInvoke(cmd, args),
    );
    prepareRaceRepo();
    const realSelectFile = useRepo.getState().selectFile;
    const selectFile = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ selectFile });

    try {
      const stage = useRepo.getState().stageFile(changedFile.path);
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("stage_file", expect.anything()));
      await useRepo.getState().selectCommitMulti("b", {}, ["a", "b"]);
      stageGate.resolve(undefined);
      await stage;

      expect(selectFile).not.toHaveBeenCalled();
      expect(useRepo.getState().selectedCommit).toBe("b");
    } finally {
      useRepo.setState({ selectFile: realSelectFile });
    }
  });

  it("does not let a delayed stage close a newly opened repository file", async () => {
    const stageGate = deferred<void>();
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) =>
      cmd === "stage_file" ? stageGate.promise : raceInvoke(cmd, args),
    );
    prepareRaceRepo();
    const realSelectFile = useRepo.getState().selectFile;
    const selectFile = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ selectFile });

    try {
      const stage = useRepo.getState().stageFile(changedFile.path);
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("stage_file", expect.anything()));
      await useRepo.getState().openRepoFile("README.md");
      stageGate.resolve(undefined);
      await stage;

      expect(selectFile).not.toHaveBeenCalled();
      expect(useRepo.getState().fileView?.path).toBe("README.md");
    } finally {
      useRepo.setState({ selectFile: realSelectFile });
    }
  });

  it("keeps a dirty repo-file draft when stage began against its prior view object", async () => {
    const stageGate = deferred<void>();
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) =>
      cmd === "stage_file" ? stageGate.promise : raceInvoke(cmd, args),
    );
    prepareRaceRepo();
    await useRepo.getState().openRepoFile("README.md");
    const realSelectFile = useRepo.getState().selectFile;
    const selectFile = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ selectFile });

    try {
      const stage = useRepo.getState().stageFile(changedFile.path);
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("stage_file", expect.anything()));
      useRepo.getState().beginFileEdit();
      useRepo.getState().updateFileDraft("dirty draft\n");
      stageGate.resolve(undefined);
      await stage;

      expect(selectFile).not.toHaveBeenCalled();
      expect(useRepo.getState().fileView?.edit?.draft).toBe("dirty draft\n");
    } finally {
      useRepo.setState({ selectFile: realSelectFile });
    }
  });

  it("settles checkout loading after a newer folder open fails before publication", async () => {
    const checkoutGate = deferred<void>();
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "checkout") return checkoutGate.promise;
      if (cmd === "open_repo" && args?.path === "/bad") return Promise.reject(new Error("bad repo"));
      return raceInvoke(cmd, args);
    });
    prepareRaceRepo();

    const checkout = useRepo.getState().checkoutBranch("feature");
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("checkout", expect.anything()));
    await useRepo.getState().loadRepo("/bad");
    expect(useRepo.getState().summary?.path).toBe("/repo");
    expect(useRepo.getState().loading).toBe(true);

    checkoutGate.resolve(undefined);
    await checkout;

    expect(useRepo.getState().loading).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("commit_graph", expect.anything());
  });

  it("does not auto-select after an openWorktree same-path load fails before publication", async () => {
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "open_repo" && args?.path === "/repo") {
        return Promise.reject(new Error("temporarily unavailable"));
      }
      return raceInvoke(cmd, args);
    });
    prepareRaceRepo();
    invokeMock.mockClear();

    await useRepo.getState().openWorktree("/repo");

    expect(invokeMock).toHaveBeenCalledWith("open_repo", { path: "/repo" });
    expect(invokeMock).not.toHaveBeenCalledWith("working_changes", expect.anything());
    expect(useRepo.getState().selectedCommit).toBe("a");
  });

  it("does not land a delayed branch move after another repo session publishes", async () => {
    const moveGate = deferred<string>();
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) =>
      cmd === "move_branch_to_worktree" ? moveGate.promise : raceInvoke(cmd, args),
    );
    prepareRaceRepo();
    const realLoadRepo = useRepo.getState().loadRepo;
    const move = useRepo
      .getState()
      .moveBranchToWorktree("feature", "/repo-feature", "/repo-dest", false);
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("move_branch_to_worktree", expect.anything()),
    );
    await realLoadRepo("/other");
    const loadRepo = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ loadRepo });

    try {
      moveGate.resolve("Moved feature");
      await move;
      expect(loadRepo).not.toHaveBeenCalled();
      expect(useRepo.getState().summary?.path).toBe("/other");
    } finally {
      useRepo.setState({ loadRepo: realLoadRepo });
    }
  });

  it("does not open a delayed worktree creation after another repo session publishes", async () => {
    const createGate = deferred<string>();
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) =>
      cmd === "add_worktree" ? createGate.promise : raceInvoke(cmd, args),
    );
    prepareRaceRepo();
    const realLoadRepo = useRepo.getState().loadRepo;
    const create = useRepo.getState().createWorktreeAt("/new-worktree", "main", "feature");
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("add_worktree", expect.anything()));
    await realLoadRepo("/other");
    const loadRepo = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ loadRepo });

    try {
      createGate.resolve("Created");
      await create;
      expect(loadRepo).not.toHaveBeenCalled();
      expect(useRepo.getState().summary?.path).toBe("/other");
    } finally {
      useRepo.setState({ loadRepo: realLoadRepo });
    }
  });

  it("does not refresh a reopened same-path session after a delayed push", async () => {
    const pushGate = deferred<string>();
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) =>
      cmd === "push_branch" ? pushGate.promise : raceInvoke(cmd, args),
    );
    prepareRaceRepo();

    const push = useRepo.getState().push();
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("push_branch", expect.anything()));
    await useRepo.getState().loadRepo("/other");
    await useRepo.getState().loadRepo("/repo");
    invokeMock.mockClear();

    pushGate.resolve("pushed");
    await push;

    expect(invokeMock).not.toHaveBeenCalledWith("commit_graph", expect.anything());
    expect(useRepo.getState().summary?.path).toBe("/repo");
  });

  it("preserves a newer A → B → A commit selection when a batch write settles", async () => {
    const cherryPickGate = deferred<void>();
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) =>
      cmd === "cherry_pick_many" ? cherryPickGate.promise : raceInvoke(cmd, args),
    );
    prepareRaceRepo();
    const originalSelection = ["a"];
    useRepo.setState({ selectedCommit: "a", selectedCommits: originalSelection, selectionAnchor: "a" });

    const picking = useRepo.getState().cherryPickMany(["b"]);
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("cherry_pick_many", expect.anything()),
    );
    useRepo.setState({ selectedCommit: "b", selectedCommits: ["b"], selectionAnchor: "b" });
    const reselectedA = ["a"];
    useRepo.setState({ selectedCommit: "a", selectedCommits: reselectedA, selectionAnchor: "a" });

    cherryPickGate.resolve(undefined);
    await picking;

    expect(useRepo.getState().selectedCommits).toBe(reselectedA);
    expect(useRepo.getState().selectedCommits).not.toBe(originalSelection);
  });

  it("clears an untouched batch selection after refresh preserves its identity", async () => {
    invokeMock.mockImplementation(raceInvoke);
    prepareRaceRepo();
    const selection = ["a", "b"];
    useRepo.setState({ selectedCommit: "b", selectedCommits: selection, selectionAnchor: "a" });

    await useRepo.getState().cherryPickMany(["a"]);

    expect(useRepo.getState().selectedCommits).toEqual([]);
  });
});
