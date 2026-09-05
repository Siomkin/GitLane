// Per-remote account routing in the write actions (GL-129): every push-family
// call must send the account bound to the remote it actually targets.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import type {
  BranchInfo,
  CommitNode,
  DiscardAllPreview,
  GithubAccountRef,
  RepoGraph,
  RepoSummary,
  WorkingChanges,
}from "@/lib/api";
import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { useAccounts, type Account } from "@/store/accounts";
import { useNotifications } from "@/store/notifications";
import { useRepo } from "@/store/repo";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const HEAD_OID = "1111111";
const summary: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: HEAD_OID,
  detached: false,
};
const emptyGraph: RepoGraph = { commits: [], edges: [], laneCount: 1, wipLane: null, head: null, truncated: false };
const EMPTY_CHANGES: WorkingChanges = {
  staged: [],
  unstaged: [],
  conflicted: [],
  advanced: emptyAdvancedState,
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
      // Every other read answers its schema's empty value; writes resolve "".
      return emptyIpcInvoke(cmd);
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

describe("stash — routine success silent, recovery warnings toast", () => {
  it("stays silent on the normalised full-tree stash success", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "stash" ? Promise.resolve("Stashed your changes.") : refreshInvoke(cmd),
    );

    await useRepo.getState().stash();

    expect(useNotifications.getState().toasts).toHaveLength(0);
  });

  it("stays silent on a one-line path stash (label may contain dots)", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "stash_paths" ? Promise.resolve("Stashed src/a.ts.") : refreshInvoke(cmd),
    );

    await useRepo.getState().stashFile("src/a.ts");

    expect(useNotifications.getState().toasts).toHaveLength(0);
  });

  it("toasts a multi-sentence recovery / partial-cleanup warning", async () => {
    const warning =
      "Stashed your changes. Git could not remove every untracked path and stopped before clearing the working tree, so GitLane finished it. Git reported: warning: failed to remove blocked/.";
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "stash" ? Promise.resolve(warning) : refreshInvoke(cmd),
    );

    await useRepo.getState().stash();

    const toast = useNotifications.getState().toasts.slice(-1)[0];
    expect(toast?.kind).toBe("success");
    expect(toast?.title).toBe(warning);
  });

  it("toasts an empty-directory qualification on a path stash", async () => {
    const warning =
      "Stashed foo.txt. Git's cleanup also removed empty untracked directory GitLane could not recreate: tmp. They held no files, so nothing was lost but the folders themselves.";
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "stash_paths" ? Promise.resolve(warning) : refreshInvoke(cmd),
    );

    await useRepo.getState().stashFile("foo.txt");

    expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toBe(warning);
  });
});

describe("outcomes no view renders still toast", () => {
  it("reports the generated filename of a commit patch", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "create_patch" ? Promise.resolve("0001-fix-thing-2.patch") : refreshInvoke(cmd),
    );

    await useRepo.getState().createPatchAt("abc1234");

    expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toBe(
      "Created patch 0001-fix-thing-2.patch",
    );
  });

  it("reports the generated filename of a range patch", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "create_patch_range" ? Promise.resolve("0001-range.patch") : refreshInvoke(cmd),
    );

    await useRepo.getState().createPatchRangeAt("abc1234", "def5678");

    expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toBe(
      "Created patch 0001-range.patch",
    );
  });

  it("reports the generated filename of a working-tree patch", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "create_working_tree_patch" ? Promise.resolve("wip.patch") : refreshInvoke(cmd),
    );

    await useRepo.getState().createWorkingTreePatch("src/a.ts");

    expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toBe("Wrote wip.patch");
  });

  it("reports a pushed tag — the tag row looks identical before and after", async () => {
    await useRepo.getState().pushTag("v1.0.0", "mirror");

    expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toBe(
      "Pushed tag v1.0.0 to mirror",
    );
  });

  it("keeps branch pushes silent — the ahead count is the confirmation", async () => {
    await useRepo.getState().pushBranch("main");

    expect(useNotifications.getState().toasts).toHaveLength(0);
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
          sparseCheckout: { enabled: true, mode: "cone", patterns: ["src/"], truncated: false },
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

    await expect(useRepo.getState().discardAll(DISCARD_ALL_PREVIEW)).rejects.toThrow(postCleanError);

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
      await expect(useRepo.getState().discardAll(DISCARD_ALL_PREVIEW)).rejects.toThrow(staleError);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      useRepo.setState({ refresh: realRefresh });
    }
  });
});

// GL-307: squash restores an index snapshot after committing, so it can reject
// *after* the replacement commit already landed. The UI must reconcile then, not
// keep painting the pre-squash range until the filesystem watcher catches up.

describe("squash — a landed squash that fails to restore staging still reconciles", () => {
  const node = (id: string, parent: string, row: number): CommitNode => ({
    id,
    shortId: id,
    summary: id,
    body: "",
    authorName: "",
    authorEmail: "",
    timestamp: 0,
    parents: [parent],
    lane: 0,
    row,
    refs: [],
  });
  const squashGraph: RepoGraph = {
    commits: [node("c2", "c1", 0), node("c1", "c0", 1), node("c0", "root", 2)],
    edges: [],
    laneCount: 1,
    wipLane: null,
    head: "c2",
    truncated: false,
  };

  it("refreshes when the backend reports the commit landed but staging was not reapplied", async () => {
    const landedError =
      "Squash commit was created, but the index changed during squash; pre-staged work was not reapplied.";
    useRepo.setState({ graph: squashGraph });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "squash_commits" ? Promise.reject(landedError) : refreshInvoke(cmd),
    );

    await expect(useRepo.getState().squashSelection(["c2", "c1"], "replacement")).rejects.toThrow(
      landedError,
    );

    expect(invokeMock).toHaveBeenCalledWith("working_changes", { path: "/repo" });
  });

  // GL-372: a range ending below the tip is a different backend contract — it
  // replays the commits above the range instead of soft-resetting onto it.
  it("routes a selection below the tip to squash_range with the range's newest commit", async () => {
    useRepo.setState({ graph: squashGraph });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "squash_range" ? Promise.resolve("newtip") : refreshInvoke(cmd),
    );

    await useRepo.getState().squashSelection(["c1", "c0"], "folded");

    expect(invokeMock).toHaveBeenCalledWith(
      "squash_range",
      expect.objectContaining({ expectedOid: HEAD_OID, newestOid: "c1", parentOid: "root" }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("squash_commits", expect.anything());
  });

  it("sends the captured sibling tip instead of HEAD and refreshes on success", async () => {
    useRepo.setState({ graph: { ...squashGraph, head: "root" } });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "squash_branch" ? Promise.resolve("newtip") : refreshInvoke(cmd),
    );
    await useRepo.getState().squashSelection(["c2", "c1"], "folded", {
      branch: "feature", oid: "c2", repoPath: "/repo",
    });
    expect(invokeMock).toHaveBeenCalledWith("squash_branch", expect.objectContaining({
      path: "/repo", expectedBranch: "feature", expectedOid: "c2", newestOid: "c2", parentOid: "c0",
    }));
    expect(invokeMock).not.toHaveBeenCalledWith("squash_commits", expect.anything());
    expect(invokeMock).toHaveBeenCalledWith("working_changes", { path: "/repo" });
  });

  it("keeps a stale target lease and refreshes after the backend refuses it", async () => {
    useRepo.setState({ graph: squashGraph });
    invokeMock.mockImplementation((cmd: string) => cmd === "squash_branch"
      ? Promise.reject("Target branch changed. Refresh and try again.") : refreshInvoke(cmd));
    await expect(useRepo.getState().squashSelection(["c2", "c1"], "folded", {
      branch: "feature", oid: "c2", repoPath: "/repo",
    })).rejects.toThrow("Target branch changed");
    expect(invokeMock).toHaveBeenCalledWith("squash_branch", expect.objectContaining({ expectedOid: "c2" }));
    expect(invokeMock).toHaveBeenCalledWith("working_changes", { path: "/repo" });
  });

  it("refuses a prompt submitted after switching repositories", async () => {
    await expect(useRepo.getState().squashSelection(["c2", "c1"], "folded", {
      branch: "feature", oid: "c2", repoPath: "/different",
    })).rejects.toThrow("Repository changed");
    expect(invokeMock).not.toHaveBeenCalledWith("squash_branch", expect.anything());
  });

  it("keeps a selection ending at the tip on squash_commits", async () => {
    useRepo.setState({ graph: squashGraph });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "squash_commits" ? Promise.resolve("ok") : refreshInvoke(cmd),
    );

    await useRepo.getState().squashSelection(["c2", "c1"], "folded");

    expect(invokeMock).toHaveBeenCalledWith(
      "squash_commits",
      expect.objectContaining({ parentOid: "c0" }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("squash_range", expect.anything());
  });
});

describe("write completions — published repo and navigation ownership", () => {
  const raceGraph: RepoGraph = {
    commits: [commitNode("a"), commitNode("b")],
    edges: [],
    laneCount: 1,
    wipLane: null,
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
    const stageGate = deferred<string>();
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) =>
      cmd === "stage_files" ? stageGate.promise : raceInvoke(cmd, args),
    );
    prepareRaceRepo();
    const realSelectFile = useRepo.getState().selectFile;
    const selectFile = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ selectFile });

    try {
      const stage = useRepo.getState().stageFile(changedFile.path);
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("stage_files", expect.anything()));
      await useRepo.getState().loadRepo("/other");
      invokeMock.mockClear();

      stageGate.resolve("Done.");
      await stage;

      expect(invokeMock).not.toHaveBeenCalledWith("commit_graph", expect.anything());
      expect(selectFile).not.toHaveBeenCalled();
      expect(useRepo.getState().summary?.path).toBe("/other");
    } finally {
      useRepo.setState({ selectFile: realSelectFile });
    }
  });

  it("drops a delayed stage completion after A → B → A reopens the same path", async () => {
    const stageGate = deferred<string>();
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) =>
      cmd === "stage_files" ? stageGate.promise : raceInvoke(cmd, args),
    );
    prepareRaceRepo();
    const realSelectFile = useRepo.getState().selectFile;
    const selectFile = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ selectFile });

    try {
      const stage = useRepo.getState().stageFile(changedFile.path);
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("stage_files", expect.anything()));
      await useRepo.getState().loadRepo("/other");
      await useRepo.getState().loadRepo("/repo");
      invokeMock.mockClear();

      stageGate.resolve("Done.");
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
    const stageGate = deferred<string>();
    let firstOpen = true;
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "open_repo" && firstOpen) {
        firstOpen = false;
        return reopenGate.promise;
      }
      if (cmd === "stage_files") return stageGate.promise;
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
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("stage_files", expect.anything()));

      reopenGate.resolve(summary);
      await reopening;
      invokeMock.mockClear();
      stageGate.resolve("Done.");
      await stage;

      expect(invokeMock).not.toHaveBeenCalledWith("commit_graph", expect.anything());
      expect(selectFile).not.toHaveBeenCalled();
    } finally {
      useRepo.setState({ selectFile: realSelectFile });
    }
  });

  it("does not let a delayed stage override a newer commit selection", async () => {
    const stageGate = deferred<string>();
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) =>
      cmd === "stage_files" ? stageGate.promise : raceInvoke(cmd, args),
    );
    prepareRaceRepo();
    const realSelectFile = useRepo.getState().selectFile;
    const selectFile = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ selectFile });

    try {
      const stage = useRepo.getState().stageFile(changedFile.path);
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("stage_files", expect.anything()));
      await useRepo.getState().selectCommitMulti("b", {}, ["a", "b"]);
      stageGate.resolve("Done.");
      await stage;

      expect(selectFile).not.toHaveBeenCalled();
      expect(useRepo.getState().selectedCommit).toBe("b");
    } finally {
      useRepo.setState({ selectFile: realSelectFile });
    }
  });

  it("does not let a delayed stage close a newly opened repository file", async () => {
    const stageGate = deferred<string>();
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) =>
      cmd === "stage_files" ? stageGate.promise : raceInvoke(cmd, args),
    );
    prepareRaceRepo();
    const realSelectFile = useRepo.getState().selectFile;
    const selectFile = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ selectFile });

    try {
      const stage = useRepo.getState().stageFile(changedFile.path);
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("stage_files", expect.anything()));
      await useRepo.getState().openRepoFile("README.md");
      stageGate.resolve("Done.");
      await stage;

      expect(selectFile).not.toHaveBeenCalled();
      expect(useRepo.getState().fileView?.path).toBe("README.md");
    } finally {
      useRepo.setState({ selectFile: realSelectFile });
    }
  });

  it("keeps a dirty repo-file draft when stage began against its prior view object", async () => {
    const stageGate = deferred<string>();
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) =>
      cmd === "stage_files" ? stageGate.promise : raceInvoke(cmd, args),
    );
    prepareRaceRepo();
    await useRepo.getState().openRepoFile("README.md");
    const realSelectFile = useRepo.getState().selectFile;
    const selectFile = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ selectFile });

    try {
      const stage = useRepo.getState().stageFile(changedFile.path);
      await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith("stage_files", expect.anything()));
      useRepo.getState().beginFileEdit();
      useRepo.getState().updateFileDraft("dirty draft\n");
      stageGate.resolve("Done.");
      await stage;

      expect(selectFile).not.toHaveBeenCalled();
      expect(useRepo.getState().fileView?.edit?.draft).toBe("dirty draft\n");
    } finally {
      useRepo.setState({ selectFile: realSelectFile });
    }
  });

  it("settles checkout loading after a newer folder open fails before publication", async () => {
    const checkoutGate = deferred<string>();
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

    checkoutGate.resolve("Switched to feature");
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
    const cherryPickGate = deferred<string>();
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

    cherryPickGate.resolve("Done.");
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
