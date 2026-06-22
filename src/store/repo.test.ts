import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the IPC boundary so the store's async actions run headlessly. `vi.mock`
// is hoisted above the import below; `vi.hoisted` makes `invokeMock` exist in time.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRepo } from "./repo";
import type { RepoGraph, RepoSummary } from "../lib/api";

// A minimal summary so actions that require an open repo proceed.
const summary: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: null,
  detached: false,
};
const emptyGraph: RepoGraph = {
  commits: [],
  edges: [],
  laneCount: 1,
  head: null,
  truncated: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  invokeMock.mockReset();
  useRepo.setState({
    summary,
    selectedFile: null,
    fileDiff: null,
    selectedCommit: null,
    graphLimit: 2_000,
    loadingMoreHistory: false,
  });
});

describe("repo store — discardFile", () => {
  it("re-points the diff at the surviving bucket for a partially-staged file", async () => {
    // The file is staged *and* unstaged; after discarding its unstaged changes
    // it survives in the staged bucket, so the selection should follow it there
    // (rather than leave the pane on a now-empty unstaged diff).
    useRepo.setState({
      changes: {
        staged: [{ path: "src/a.ts", status: "M", add: 1, del: 0 }],
        unstaged: [{ path: "src/a.ts", status: "M", add: 2, del: 0 }],
      },
      selectedFile: { path: "src/a.ts", source: "unstaged" },
    });

    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "discard_file":
          return Promise.resolve("Discarded changes in src/a.ts");
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        case "working_changes":
          // The unstaged side is gone; the file remains staged.
          return Promise.resolve({
            staged: [{ path: "src/a.ts", status: "M", add: 1, del: 0 }],
            unstaged: [],
          });
        case "file_diff":
          return Promise.resolve({ path: "src/a.ts", status: "M", binary: false, hunks: [] });
        default:
          // list_branches / list_worktrees / list_stashes / PR fan-out, etc.
          return Promise.resolve([]);
      }
    });

    await useRepo.getState().discardFile("src/a.ts", false);

    expect(useRepo.getState().selectedFile).toEqual({ path: "src/a.ts", source: "staged" });
    expect(invokeMock).toHaveBeenCalledWith("discard_file", {
      path: "/repo",
      file: "src/a.ts",
      staged: false,
    });
  });

  it("drops the selection when the file is fully discarded", async () => {
    useRepo.setState({
      changes: {
        staged: [],
        unstaged: [{ path: "src/a.ts", status: "M", add: 2, del: 0 }],
      },
      selectedFile: { path: "src/a.ts", source: "unstaged" },
    });

    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "discard_file":
          return Promise.resolve("Discarded changes in src/a.ts");
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        case "working_changes":
          // Nothing left — `refresh` should clear the stale selection.
          return Promise.resolve({ staged: [], unstaged: [] });
        default:
          return Promise.resolve([]);
      }
    });

    await useRepo.getState().discardFile("src/a.ts", false);

    expect(useRepo.getState().selectedFile).toBeNull();
  });
});

describe("repo store — large history", () => {
  it("loads the next graph page and preserves the larger limit", async () => {
    useRepo.setState({
      graph: {
        commits: [],
        edges: [],
        laneCount: 1,
        head: null,
        truncated: true,
      },
      selectedCommit: "selected",
      selectedCommits: ["selected"],
    });
    invokeMock.mockResolvedValueOnce({
      commits: [{ id: "selected" }],
      edges: [],
      laneCount: 1,
      head: "selected",
      truncated: false,
    });

    await useRepo.getState().loadMoreHistory();

    expect(invokeMock).toHaveBeenCalledWith("commit_graph", {
      path: "/repo",
      limit: 4_000,
    });
    expect(useRepo.getState().graphLimit).toBe(4_000);
    expect(useRepo.getState().selectedCommit).toBe("selected");
    expect(useRepo.getState().loadingMoreHistory).toBe(false);
  });

  it("uses a worktree-only watcher refresh without rebuilding the graph", async () => {
    const graph = {
      commits: [],
      edges: [],
      laneCount: 1,
      head: null,
      truncated: false,
    };
    useRepo.setState({ graph });
    invokeMock.mockResolvedValueOnce({ staged: [], unstaged: [] });

    await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("working_changes", { path: "/repo" });
    expect(useRepo.getState().graph).toBe(graph);
  });

  it("clears a WIP selection when a worktree refresh becomes clean", async () => {
    useRepo.setState({ wipSelected: true });
    invokeMock.mockResolvedValueOnce({ staged: [], unstaged: [] });

    await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });

    expect(useRepo.getState().wipSelected).toBe(false);
  });

  it("ignores a stale load-more result after a newer full refresh", async () => {
    const slowLoadMore = deferred<typeof emptyGraph>();
    const refreshedGraph = { ...emptyGraph, head: "fresh" };
    let graphCalls = 0;
    useRepo.setState({
      graph: { ...emptyGraph, truncated: true },
      selectedCommit: null,
      selectedCommits: [],
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "commit_graph") {
        graphCalls += 1;
        return graphCalls === 1 ? slowLoadMore.promise : Promise.resolve(refreshedGraph);
      }
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return Promise.resolve([]);
    });

    const loadMore = useRepo.getState().loadMoreHistory();
    await useRepo.getState().refresh({ prs: false, quiet: true });
    slowLoadMore.resolve({ ...emptyGraph, head: "stale" });
    await loadMore;

    expect(useRepo.getState().graph).toBe(refreshedGraph);
    expect(useRepo.getState().graphLimit).toBe(2_000);
    expect(useRepo.getState().loadingMoreHistory).toBe(false);
  });

  it("ignores a load-more result after switching repositories", async () => {
    const slowLoadMore = deferred<typeof emptyGraph>();
    useRepo.setState({ graph: { ...emptyGraph, truncated: true } });
    invokeMock.mockReturnValueOnce(slowLoadMore.promise);

    const loadMore = useRepo.getState().loadMoreHistory();
    useRepo.setState({
      summary: { ...summary, path: "/other" },
      graph: { ...emptyGraph, head: "other" },
      loadingMoreHistory: false,
    });
    slowLoadMore.resolve({ ...emptyGraph, head: "stale" });
    await loadMore;

    expect(useRepo.getState().graph?.head).toBe("other");
  });

  it("clears the active repo state if switching after close cannot load", async () => {
    useRepo.setState({
      summary,
      openPaths: ["/repo", "/other"],
      graph: emptyGraph,
    });
    invokeMock.mockRejectedValueOnce(new Error("cannot open"));

    await useRepo.getState().closeRepo("/repo");

    expect(useRepo.getState().openPaths).toEqual(["/other"]);
    expect(useRepo.getState().summary).toBeNull();
    expect(useRepo.getState().graph).toBeNull();
    expect(useRepo.getState().graphLimit).toBe(2_000);
    expect(useRepo.getState().error).toContain("cannot open");
  });
});

describe("repo store — fastForwardTo", () => {
  // Resolve every refresh fan-out command so runOp's trailing refresh() settles.
  function stubRefresh() {
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        case "working_changes":
          return Promise.resolve({ staged: [], unstaged: [] });
        default:
          return Promise.resolve([]);
      }
    });
  }

  it("moves a non-current branch in place without a checkout", async () => {
    // On `main`, advance `develop` to `origin/develop`: no checkout, ref updated
    // via fast_forward_branch so the working tree stays put.
    useRepo.setState({ summary });
    stubRefresh();

    await useRepo.getState().fastForwardTo("origin/develop", "develop");

    expect(invokeMock).toHaveBeenCalledWith("fast_forward_branch", {
      path: "/repo",
      branch: "develop",
      target: "origin/develop",
    });
    expect(invokeMock).not.toHaveBeenCalledWith("checkout", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("fast_forward", expect.anything());
  });

  it("fast-forwards the current branch in the working tree", async () => {
    // The moved branch IS HEAD, so merge --ff-only the working tree forward.
    useRepo.setState({ summary });
    stubRefresh();

    await useRepo.getState().fastForwardTo("origin/main", "main");

    expect(invokeMock).toHaveBeenCalledWith("fast_forward", {
      path: "/repo",
      target: "origin/main",
    });
    expect(invokeMock).not.toHaveBeenCalledWith("fast_forward_branch", expect.anything());
  });
});
