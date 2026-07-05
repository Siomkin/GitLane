// Per-remote account routing in the write actions (GL-129): every push-family
// call must send the account bound to the remote it actually targets.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { emptyAdvancedState } from "../lib/advancedRepoState";
import type {
  BranchInfo,
  GithubAccountRef,
  RepoGraph,
  RepoSummary,
  WorkingChanges,
} from "../lib/api";
import { useAccounts, type Account } from "./accounts";
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
  useRepo.setState({
    summary,
    remotes: [
      remote("origin", "https://github.com/owner/repo.git", true),
      remote("mirror", "https://github.com/owner/mirror.git"),
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

describe("fetch — per-remote account pairs (GL-129)", () => {
  it("sends one {remote, account} pair per bound remote, omitting unbound ones", async () => {
    await useRepo.getState().fetch();

    expect(invokeMock).toHaveBeenCalledWith("fetch", {
      path: "/repo",
      remoteAccounts: [
        { remote: "origin", account: alice.ref },
        { remote: "mirror", account: bob.ref },
      ],
    });
  });
});

describe("push family — the target remote's account, not a repo-wide one", () => {
  it("bare push sends the head branch's push-remote account", async () => {
    await useRepo.getState().push();

    // Head branch `main` pushes to `mirror`, bound to bob — not the default
    // remote's alice.
    expect(invokeMock).toHaveBeenCalledWith("push", { path: "/repo", account: bob.ref });
  });

  it("pushBranch resolves the named branch's remote (origin fallback)", async () => {
    await useRepo.getState().pushBranch("feat");

    expect(invokeMock).toHaveBeenCalledWith("push_branch", {
      path: "/repo",
      branch: "feat",
      account: alice.ref,
    });
  });

  it("publishBranch picks the account of the upstream's remote", async () => {
    await useRepo.getState().publishBranch("feat", "bucket/feat");

    // bucket is bitbucket.org → system git credentials (no account).
    expect(invokeMock).toHaveBeenCalledWith("publish_branch", {
      path: "/repo",
      branch: "feat",
      upstream: "bucket/feat",
      account: null,
    });
  });

  it("deleteRemoteBranch uses the explicit remote's account", async () => {
    await useRepo.getState().deleteRemoteBranch("mirror", "feat");

    expect(invokeMock).toHaveBeenCalledWith("delete_remote_branch", {
      path: "/repo",
      remote: "mirror",
      branch: "feat",
      account: bob.ref,
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
      account: bob.ref,
    });
  });

  it("pushTag falls back to the default remote", async () => {
    await useRepo.getState().pushTag("v1.0.0");

    expect(invokeMock).toHaveBeenCalledWith("push_tag", {
      path: "/repo",
      name: "v1.0.0",
      remote: "origin",
      account: alice.ref,
    });
  });

  it("deleteTag(alsoRemote) deletes on the default remote and names it in the toast", async () => {
    const message = await useRepo.getState().deleteTag("v1.0.0", true);

    expect(invokeMock).toHaveBeenCalledWith("delete_remote_tag", {
      path: "/repo",
      name: "v1.0.0",
      remote: "origin",
      account: alice.ref,
    });
    expect(message).toBe("Deleted tag v1.0.0 (local and origin)");
  });
});
