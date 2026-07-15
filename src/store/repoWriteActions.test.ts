// Per-remote account routing in the write actions (GL-129): every push-family
// call must send the account bound to the remote it actually targets.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { emptyAdvancedState } from "@/lib/advancedRepoState";
import type {
  BranchInfo,
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

const summary: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: null,
  detached: false,
};
const emptyGraph: RepoGraph = { commits: [], edges: [], laneCount: 1, head: null, truncated: false };
const EMPTY_CHANGES: WorkingChanges = {
  staged: [],
  unstaged: [],
  conflicted: [],
  advanced: emptyAdvancedState,
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

const mkAccount = (accountId: string, login: string): Account => {
  const ref: GithubAccountRef = { provider: "gh", host: "github.com", accountId, login };
  return {
    id: `gh:github.com:${accountId}`,
    forge: "GitHub",
    provider: "gh",
    host: "github.com",
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
  host: "github.com",
  credentialHost: "github.com",
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
  target: null,
  isHead: false,
  upstream: null,
  remote: null,
  upstreamRemote: null,
  sync: null,
  ...over,
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

  it("holds netOps — but never `loading` — while the quiet fetch is on the wire", async () => {
    let netOpsDuring = -1;
    let loadingDuring = true;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "fetch") {
        netOpsDuring = useRepo.getState().netOps;
        loadingDuring = useRepo.getState().loading;
        return Promise.resolve(null);
      }
      return refreshInvoke(cmd);
    });

    const ok = await useRepo.getState().fetch({ quiet: true });

    expect(ok).toBe(true);
    expect(netOpsDuring).toBe(1);
    // The ActionBar disables on `loading`; a background fetch must not flip it.
    expect(loadingDuring).toBe(false);
    expect(useRepo.getState().netOps).toBe(0);
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

    expect(invokeMock).toHaveBeenCalledWith("pull", { path: "/repo", auth: ghAuth(bob) });
  });

  it("bare push sends the head branch's push-remote account", async () => {
    await useRepo.getState().push();

    // Head branch `main` pushes to `mirror`, bound to bob — not the default
    // remote's alice.
    expect(invokeMock).toHaveBeenCalledWith("push", { path: "/repo", auth: ghAuth(bob) });
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

  it("drops the progress toast and surfaces an error toast when the push fails", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "push" ? Promise.reject("remote rejected") : refreshInvoke(cmd),
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
      auth: ghAuth(alice),
    });
  });

  it("publishBranch picks the account of the upstream's remote", async () => {
    await useRepo.getState().publishBranch("feat", "bucket/feat");

    // bucket is Bitbucket → URL username plus system credential helper.
    expect(invokeMock).toHaveBeenCalledWith("publish_branch", {
      path: "/repo",
      branch: "feat",
      upstream: "bucket/feat",
      auth: bucketAuth,
    });
  });

  it("deleteRemoteBranch uses the explicit remote's account", async () => {
    await useRepo.getState().deleteRemoteBranch("mirror", "feat");

    expect(invokeMock).toHaveBeenCalledWith("delete_remote_branch", {
      path: "/repo",
      remote: "mirror",
      branch: "feat",
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
    const message = await useRepo.getState().deleteTag("v1.0.0", true);

    expect(invokeMock).toHaveBeenCalledWith("delete_remote_tag", {
      path: "/repo",
      name: "v1.0.0",
      remote: "origin",
      auth: ghAuth(alice),
    });
    expect(message).toBe("Deleted tag v1.0.0 (local and origin)");
  });
});
