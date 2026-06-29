import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the IPC boundary so the store's async actions run headlessly. `vi.mock`
// is hoisted above the import below; `vi.hoisted` makes `invokeMock` exist in time.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRepo } from "./repo";
import type { OperationState } from "./repo";
import { usePulls } from "./pulls";
import { useUi } from "./ui";
import { ForgeKind } from "../lib/api";
import type { PullRequest } from "../lib/prs";
import type {
  BranchInfo,
  RepoForge,
  RepoGraph,
  RepoSummary,
  StashEntry,
  WorkingChanges,
  WorktreeInfo,
} from "../lib/api";

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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
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
        conflicted: [],
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
        conflicted: [],
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

describe("repo store — advanced write guards", () => {
  it("blocks stageFile for a visible path outside sparse checkout", async () => {
    const showToast = vi.fn();
    const originalShowToast = useUi.getState().showToast;
    useUi.setState({ showToast });
    useRepo.setState({
      changes: {
        staged: [],
        unstaged: [{ path: "docs/hidden.txt", status: "M", add: 1, del: 1 }],
        conflicted: [],
        advanced: {
          submodules: [],
          lfs: { detected: false, installed: null, issues: [], patterns: [] },
          sparseCheckout: { enabled: true, mode: "cone", patterns: ["/*", "!/*/", "/src/"] },
        },
      },
    });

    try {
      await useRepo.getState().stageFile("docs/hidden.txt");

      expect(invokeMock).not.toHaveBeenCalledWith("stage_file", expect.anything());
      expect(showToast).toHaveBeenCalledWith(
        "Outside sparse checkout. Expand the sparse checkout or use git add --sparse.",
        "error",
      );
    } finally {
      useUi.setState({ showToast: originalShowToast });
    }
  });

  it("blocks patch-level staging for a guarded sparse path", async () => {
    const showToast = vi.fn();
    const originalShowToast = useUi.getState().showToast;
    useUi.setState({ showToast });
    useRepo.setState({
      changes: {
        staged: [],
        unstaged: [{ path: "docs/hidden.txt", status: "M", add: 1, del: 1 }],
        conflicted: [],
        advanced: {
          submodules: [],
          lfs: { detected: false, installed: null, issues: [], patterns: [] },
          sparseCheckout: { enabled: true, mode: "cone", patterns: ["/*", "!/*/", "/src/"] },
        },
      },
    });

    try {
      await useRepo.getState().applyHunk("docs/hidden.txt", false, 0, "@@ -1 +1 @@", "-one\n+two");
      await useRepo.getState().applyLine(
        "docs/hidden.txt",
        false,
        0,
        0,
        { kind: "add", oldNo: null, newNo: 1, content: "two" },
      );

      expect(invokeMock).not.toHaveBeenCalledWith("apply_hunk", expect.anything());
      expect(invokeMock).not.toHaveBeenCalledWith("apply_line", expect.anything());
      expect(showToast).toHaveBeenCalledWith(
        "Outside sparse checkout. Expand the sparse checkout or use git add --sparse.",
        "error",
      );
      expect(showToast).toHaveBeenCalledTimes(2);
    } finally {
      useUi.setState({ showToast: originalShowToast });
    }
  });

  it("allows stash when sparse checkout is only informational", async () => {
    useRepo.setState({
      changes: {
        staged: [],
        unstaged: [{ path: "src/visible.txt", status: "M", add: 1, del: 0 }],
        conflicted: [],
        advanced: {
          submodules: [],
          lfs: { detected: false, installed: null, issues: [], patterns: [] },
          sparseCheckout: { enabled: true, mode: "cone", patterns: ["src/"] },
        },
      },
    });
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "stash":
          return Promise.resolve("Saved working directory");
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        case "working_changes":
          return Promise.resolve({ staged: [], unstaged: [], conflicted: [] });
        default:
          return Promise.resolve([]);
      }
    });

    await useRepo.getState().stash();

    expect(invokeMock).toHaveBeenCalledWith("stash", { path: "/repo" });
  });

  it("blocks stash when a dirty submodule row is present", async () => {
    const showToast = vi.fn();
    const originalShowToast = useUi.getState().showToast;
    useUi.setState({ showToast });
    useRepo.setState({
      changes: {
        staged: [],
        unstaged: [
          {
            path: "deps/child",
            status: "M",
            add: 0,
            del: 0,
            advanced: { kind: "submodule", message: "Submodule: modified files inside submodule" },
          },
        ],
        conflicted: [],
      },
    });

    try {
      await useRepo.getState().stash();

      expect(invokeMock).not.toHaveBeenCalledWith("stash", expect.anything());
      expect(showToast).toHaveBeenCalledWith(
        "Submodule: modified files inside submodule. Use the terminal for submodule updates.",
        "error",
      );
    } finally {
      useUi.setState({ showToast: originalShowToast });
    }
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
    // A worktree refresh reads working changes + operation status, but never
    // rebuilds the graph.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      if (cmd === "operation_status")
        return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
      return Promise.resolve([]);
    });

    await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });

    expect(invokeMock).toHaveBeenCalledWith("working_changes", { path: "/repo" });
    expect(invokeMock).not.toHaveBeenCalledWith("commit_graph", expect.anything());
    expect(useRepo.getState().graph).toBe(graph);
  });

  it("clears a WIP selection when a worktree refresh becomes clean", async () => {
    useRepo.setState({ wipSelected: true });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      if (cmd === "operation_status")
        return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
      return Promise.resolve([]);
    });

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

describe("repo store — reorderOpenPaths", () => {
  it("reorders open repo tabs and keeps the active repo selected", () => {
    localStorage.clear();
    useRepo.setState({
      summary: { ...summary, path: "/b" },
      openPaths: ["/a", "/b", "/c"],
    });

    useRepo.getState().reorderOpenPaths(2, 0);

    expect(useRepo.getState().openPaths).toEqual(["/c", "/a", "/b"]);
    expect(useRepo.getState().summary?.path).toBe("/b");
    expect(JSON.parse(localStorage.getItem("gitlane.openPaths") ?? "[]")).toEqual([
      "/c",
      "/a",
      "/b",
    ]);
    expect(localStorage.getItem("gitlane.lastPath")).toBe("/b");
  });

  it("keeps the active repo selected when its own tab is dragged", () => {
    localStorage.clear();
    useRepo.setState({
      summary: { ...summary, path: "/a" },
      openPaths: ["/a", "/b", "/c"],
    });

    // Drag the active tab (/a) from the front to the end.
    useRepo.getState().reorderOpenPaths(0, 2);

    expect(useRepo.getState().openPaths).toEqual(["/b", "/c", "/a"]);
    expect(useRepo.getState().summary?.path).toBe("/a");
    expect(JSON.parse(localStorage.getItem("gitlane.openPaths") ?? "[]")).toEqual([
      "/b",
      "/c",
      "/a",
    ]);
    expect(localStorage.getItem("gitlane.lastPath")).toBe("/a");
  });

  it("ignores invalid or same-index reorder requests", () => {
    localStorage.clear();
    useRepo.setState({
      summary,
      openPaths: ["/a", "/b"],
    });

    useRepo.getState().reorderOpenPaths(1, 1);
    useRepo.getState().reorderOpenPaths(-1, 0);
    useRepo.getState().reorderOpenPaths(0, 2);

    expect(useRepo.getState().openPaths).toEqual(["/a", "/b"]);
    expect(localStorage.getItem("gitlane.openPaths")).toBeNull();
  });
});

describe("repo store — loadRepo failed open", () => {
  it("keeps the previous repo's summary + graph/refs/changes intact when open_repo fails", async () => {
    // A fully-loaded previous repo. open_repo is the cheap first step of an open;
    // if it throws (invalid folder), the toolbar must not be left pointing at the
    // old repo over an emptied graph/navigator (GL-20 review fix).
    const prevSummary: RepoSummary = {
      path: "/old",
      workdir: "/old",
      headBranch: "main",
      headOid: "abc1234",
      detached: false,
    };
    const prevGraph: RepoGraph = { ...emptyGraph, head: "abc1234" };
    const prevBranches: BranchInfo[] = [
      { name: "main", kind: "local", target: "abc1234", isHead: true, upstream: null },
    ];
    const prevWorktrees: WorktreeInfo[] = [
      { name: "old", path: "/old", branch: "main", isMain: true },
    ];
    const prevStashes: StashEntry[] = [
      { index: 0, message: "wip", oid: "s1", timestamp: 0, baseOid: "abc1234", baseTimestamp: 0, context: [] },
    ];
    const prevChanges: WorkingChanges = {
      staged: [{ path: "a.ts", status: "M", add: 1, del: 0 }],
      unstaged: [],
      conflicted: [],
    };
    useRepo.setState({
      summary: prevSummary,
      graph: prevGraph,
      branches: prevBranches,
      worktrees: prevWorktrees,
      stashes: prevStashes,
      changes: prevChanges,
      selectedCommit: "abc1234",
      selectedCommits: ["abc1234"],
      loading: false,
      graphLoading: false,
      error: null,
    });

    invokeMock.mockRejectedValueOnce(new Error("not a git repository"));

    await useRepo.getState().loadRepo("/does-not-exist");

    const s = useRepo.getState();
    // Summary AND its data survive together — not a live summary over empty data.
    expect(s.summary).toBe(prevSummary);
    expect(s.graph).toBe(prevGraph);
    expect(s.branches).toBe(prevBranches);
    expect(s.worktrees).toBe(prevWorktrees);
    expect(s.stashes).toBe(prevStashes);
    expect(s.changes).toBe(prevChanges);
    // …and the failure surfaces, with both loading flags cleared.
    expect(s.error).toContain("not a git repository");
    expect(s.loading).toBe(false);
    expect(s.graphLoading).toBe(false);
    // open_repo was the only call; no data slice fanned out past the failure.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("open_repo", { path: "/does-not-exist" });
  });
});

describe("repo store — loadRepo progressive open", () => {
  it("resets stale PR state before the commit graph resolves", async () => {
    // A previous repo's PRs are still in the store when a new open begins.
    usePulls.setState({
      pullRequests: [{ num: 99 } as unknown as PullRequest],
      prDetails: { 99: { num: 99 } as unknown as PullRequest },
      prError: "stale error",
      prsFetchedAt: 123,
    });

    // Hold the graph open: its payload is the slow part of an open, so this is
    // exactly the window where the ActionBar could pair the new summary with the
    // old repo's PRs (GL-20 review fix).
    const graphDeferred = deferred<RepoGraph>();
    let prsAtGraphCall: PullRequest[] | null = null;
    let prErrorAtGraphCall: string | null = "unset";
    let graphLoadingAtGraphCall = false;
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          // Snapshot PR + loading state at the instant the graph load begins —
          // i.e. after the synchronous reset, before the graph resolves.
          prsAtGraphCall = usePulls.getState().pullRequests;
          prErrorAtGraphCall = usePulls.getState().prError;
          graphLoadingAtGraphCall = useRepo.getState().graphLoading;
          return graphDeferred.promise;
        default:
          // list_branches / list_worktrees / list_stashes / working_changes /
          // list_pull_requests / repo_identity / watch_repo.
          return Promise.resolve([]);
      }
    });

    const open = useRepo.getState().loadRepo("/repo");
    // Let loadRepo run through openRepo + the synchronous PR reset and park on
    // the (still-pending) commit_graph await.
    await new Promise((resolve) => setTimeout(resolve));

    expect(prsAtGraphCall).toEqual([]);
    expect(prErrorAtGraphCall).toBeNull();
    expect(graphLoadingAtGraphCall).toBe(true);

    graphDeferred.resolve(emptyGraph);
    await open;
  });

  it("defaults the selection to the newest real commit, skipping an interleaved stash node", async () => {
    // A fresh stash sorts above HEAD, so the Rust layout puts it at commits[0].
    // The default selection must skip it and land on the newest real commit, or
    // the inspector would load a stash oid as a commit.
    const graph: RepoGraph = {
      ...emptyGraph,
      head: "real-tip",
      commits: [
        { id: "s0", stash: { index: 0, message: "WIP" } },
        { id: "real-tip" },
      ] as unknown as RepoGraph["commits"],
    };
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(graph);
        case "working_changes":
          return Promise.resolve({ staged: [], unstaged: [] });
        default:
          return Promise.resolve([]);
      }
    });

    await useRepo.getState().loadRepo("/repo");

    expect(useRepo.getState().selectedCommit).toBe("real-tip");
  });

  it("surfaces an error when the required list_branches read fails", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        case "list_branches":
          return Promise.reject(new Error("branches boom"));
        default:
          return Promise.resolve([]);
      }
    });

    await useRepo.getState().loadRepo("/repo");
    // The required-slice catch sets `error` from a fire-and-forget read; drain
    // pending microtasks before asserting.
    await new Promise((resolve) => setTimeout(resolve));

    expect(useRepo.getState().error).toContain("branches boom");
  });

  it("surfaces an error when the required working_changes read fails", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        case "working_changes":
          return Promise.reject(new Error("status boom"));
        default:
          return Promise.resolve([]);
      }
    });

    await useRepo.getState().loadRepo("/repo");
    await new Promise((resolve) => setTimeout(resolve));

    expect(useRepo.getState().error).toContain("status boom");
  });

  it("stays error-free when a best-effort read (list_stashes) fails", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        case "list_stashes":
          return Promise.reject(new Error("stashes boom"));
        default:
          return Promise.resolve([]);
      }
    });

    await useRepo.getState().loadRepo("/repo");
    await new Promise((resolve) => setTimeout(resolve));

    // Worktrees/stashes degrade silently to empty — only branches/working changes
    // are required state.
    expect(useRepo.getState().error).toBeNull();
  });

  it("does not orphan an in-flight graph when a later pick fails to open", async () => {
    const summaryA: RepoSummary = {
      path: "/a",
      workdir: "/a",
      headBranch: "main",
      headOid: null,
      detached: false,
    };
    const graphA = deferred<RepoGraph>();
    invokeMock.mockImplementation((cmd: string, args: { path?: string }) => {
      if (cmd === "open_repo") {
        return args.path === "/a"
          ? Promise.resolve(summaryA)
          : Promise.reject(new Error("bad pick"));
      }
      if (cmd === "commit_graph") return graphA.promise;
      return Promise.resolve([]);
    });

    // Open A; park it on the (still-pending) graph load.
    const openA = useRepo.getState().loadRepo("/a");
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().summary).toBe(summaryA);
    expect(useRepo.getState().graphLoading).toBe(true);

    // A second pick fails at open_repo. It must surface its error WITHOUT
    // superseding A's load — no generation bump, no flag changes (GL-20 review).
    await useRepo.getState().loadRepo("/does-not-exist");
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().error).toContain("bad pick");
    expect(useRepo.getState().summary).toBe(summaryA);
    expect(useRepo.getState().graphLoading).toBe(true);
    expect(useRepo.getState().loading).toBe(true);

    // A's graph resolves and still paints — it was never orphaned.
    graphA.resolve(emptyGraph);
    await openA;
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().graph).toBe(emptyGraph);
    expect(useRepo.getState().graphLoading).toBe(false);
    expect(useRepo.getState().loading).toBe(false);
  });

  it("keeps the newer pick active when an earlier slow open resolves last", async () => {
    const summaryA: RepoSummary = {
      path: "/a",
      workdir: "/a",
      headBranch: "a",
      headOid: null,
      detached: false,
    };
    const summaryB: RepoSummary = {
      path: "/b",
      workdir: "/b",
      headBranch: "b",
      headOid: null,
      detached: false,
    };
    const openA = deferred<RepoSummary>();
    invokeMock.mockImplementation((cmd: string, args: { path?: string }) => {
      if (cmd === "open_repo") {
        return args.path === "/a" ? openA.promise : Promise.resolve(summaryB);
      }
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return Promise.resolve([]);
    });

    // Pick A (its open hangs), then immediately pick B (opens fast → becomes active).
    const loadA = useRepo.getState().loadRepo("/a");
    await useRepo.getState().loadRepo("/b");
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().summary).toBe(summaryB);

    // A's open finally resolves — as the superseded pick it must NOT publish over B.
    openA.resolve(summaryA);
    await loadA;
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().summary).toBe(summaryB);
    expect(useRepo.getState().graph).toBe(emptyGraph);
  });

  it("does not error on the active repo when an older failed open rejects late", async () => {
    const summaryB: RepoSummary = {
      path: "/b",
      workdir: "/b",
      headBranch: "b",
      headOid: null,
      detached: false,
    };
    const openBad = deferred<RepoSummary>();
    invokeMock.mockImplementation((cmd: string, args: { path?: string }) => {
      if (cmd === "open_repo") {
        return args.path === "/bad" ? openBad.promise : Promise.resolve(summaryB);
      }
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return Promise.resolve([]);
    });

    // Pick a bad repo whose open hangs, then pick B which opens and becomes active.
    const loadBad = useRepo.getState().loadRepo("/bad");
    await useRepo.getState().loadRepo("/b");
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().summary).toBe(summaryB);
    expect(useRepo.getState().error).toBeNull();

    // The older bad open finally rejects — it must NOT surface an error over B.
    openBad.reject(new Error("bad pick"));
    await loadBad;
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().error).toBeNull();
    expect(useRepo.getState().summary).toBe(summaryB);
  });

  it("honors a branch picked during the load instead of snapping to the tip", async () => {
    const loadedGraph: RepoGraph = {
      commits: [
        { id: "head", shortId: "head", summary: "head", body: "", authorName: "", authorEmail: "", timestamp: 0, parents: [], lane: 0, row: 0, color: 0, refs: [] },
        { id: "tip", shortId: "tip", summary: "feat", body: "", authorName: "", authorEmail: "", timestamp: 0, parents: ["head"], lane: 0, row: 1, color: 0, refs: [] },
      ],
      edges: [],
      laneCount: 1,
      head: "head",
      truncated: false,
    };
    const graphDeferred = deferred<RepoGraph>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return graphDeferred.promise;
      if (cmd === "commit_files") return Promise.resolve([{ path: "f.ts", status: "M", add: 1, del: 0 }]);
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return Promise.resolve([]);
    });
    useRepo.setState({ openPaths: ["/repo"] });

    const open = useRepo.getState().loadRepo("/repo");
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().graphLoading).toBe(true);

    // The branch navigator is usable while the skeleton shows — pick a branch tip.
    await useRepo.getState().revealCommit("tip");
    expect(useRepo.getState().selectedCommit).toBe("tip");

    // When the graph lands, the pick must survive (GL-20 review) — the graph would
    // otherwise scroll to "tip" (revealTarget) while the inspector showed HEAD.
    graphDeferred.resolve(loadedGraph);
    await open;
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().selectedCommit).toBe("tip");
    expect(useRepo.getState().revealTarget).toBe("tip");
  });

  it("falls back to the tip when a during-load pick is outside the loaded graph window", async () => {
    // The loaded window holds only head/tip; the user picks an old branch tip
    // beyond the initial limit, so it isn't in `graph.commits`.
    const loadedGraph: RepoGraph = {
      commits: [
        { id: "head", shortId: "head", summary: "head", body: "", authorName: "", authorEmail: "", timestamp: 0, parents: [], lane: 0, row: 0, color: 0, refs: [] },
        { id: "tip", shortId: "tip", summary: "feat", body: "", authorName: "", authorEmail: "", timestamp: 0, parents: ["head"], lane: 0, row: 1, color: 0, refs: [] },
      ],
      edges: [],
      laneCount: 1,
      head: "head",
      truncated: true,
    };
    const graphDeferred = deferred<RepoGraph>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return graphDeferred.promise;
      if (cmd === "commit_files") return Promise.resolve([{ path: "f.ts", status: "M", add: 1, del: 0 }]);
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return Promise.resolve([]);
    });
    useRepo.setState({ openPaths: ["/repo"] });

    const open = useRepo.getState().loadRepo("/repo");
    await new Promise((resolve) => setTimeout(resolve));
    // Pick a commit that the loaded window will not contain.
    await useRepo.getState().revealCommit("old-out-of-window");
    expect(useRepo.getState().selectedCommit).toBe("old-out-of-window");

    graphDeferred.resolve(loadedGraph);
    await open;
    await new Promise((resolve) => setTimeout(resolve));

    // The unreachable pick is dropped: selection snaps to the tip and the stale
    // reveal is cleared so the inspector + graph can't disagree (GL-20 review).
    expect(useRepo.getState().selectedCommit).toBe("head");
    expect(useRepo.getState().revealTarget).toBeNull();
  });

  it("applies a slow secondary read even after a load-more bumps the graph generation", async () => {
    const branchesDeferred = deferred<BranchInfo[]>();
    const truncatedGraph: RepoGraph = { ...emptyGraph, truncated: true };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return Promise.resolve(truncatedGraph);
      if (cmd === "list_branches") return branchesDeferred.promise;
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return Promise.resolve([]);
    });
    useRepo.setState({ openPaths: ["/repo"], branches: [] });

    // Open completes (graph lands) while the branches read is still in flight.
    await useRepo.getState().loadRepo("/repo");
    // An unrelated "load more" bumps the graph generation mid-flight.
    await useRepo.getState().loadMoreHistory();

    const picked: BranchInfo[] = [
      { name: "main", kind: "local", target: "head", isHead: true, upstream: null },
    ];
    branchesDeferred.resolve(picked);
    await new Promise((resolve) => setTimeout(resolve));

    // Guarded by repo identity, not the bumped generation, so it still lands
    // instead of being silently dropped (GL-20 review).
    expect(useRepo.getState().branches).toHaveLength(1);
  });

  it("replays a deferred watcher sync after a failed checkout", async () => {
    const checkoutDeferred = deferred<void>();
    let graphCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "checkout") return checkoutDeferred.promise;
      if (cmd === "commit_graph") {
        graphCalls += 1;
        return Promise.resolve(emptyGraph);
      }
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return Promise.resolve([]);
    });
    useRepo.setState({ summary, graph: emptyGraph, loading: false });

    const checkout = useRepo.getState().checkoutBranch("feature").catch(() => {});
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().loading).toBe(true);

    // A watcher event lands while the checkout holds `loading` → deferred, not run.
    await useRepo.getState().refresh({ prs: false, quiet: true, scope: "all" });
    expect(graphCalls).toBe(0);

    // The checkout fails; its catch must still replay the deferred sync (GL-20 review).
    checkoutDeferred.reject(new Error("conflict"));
    await checkout;
    await new Promise((resolve) => setTimeout(resolve));
    await new Promise((resolve) => setTimeout(resolve));

    expect(useRepo.getState().loading).toBe(false);
    expect(graphCalls).toBeGreaterThanOrEqual(1);
  });

  it("does not drop a deferred watcher sync when a manual refresh is superseded", async () => {
    const slowGraph = deferred<RepoGraph>();
    let graphCallsB = 0;
    invokeMock.mockImplementation((cmd: string, args: { path?: string }) => {
      if (cmd === "open_repo") {
        return Promise.resolve(
          args.path === "/b" ? { ...summary, path: "/b", workdir: "/b" } : summary,
        );
      }
      if (cmd === "commit_graph") {
        // The manual refresh on /repo hangs; the /b load and any replay resolve.
        if (args.path === "/b") graphCallsB += 1;
        return args.path === "/repo" ? slowGraph.promise : Promise.resolve(emptyGraph);
      }
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return Promise.resolve([]);
    });
    useRepo.setState({ summary, graph: emptyGraph, loading: false, openPaths: ["/repo", "/b"] });

    // A manual (non-quiet) refresh holds `loading` and hangs on its graph fetch.
    const manual = useRepo.getState().refresh({ prs: false });
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().loading).toBe(true);

    // A watcher event lands during that window → it must be deferred, not dropped.
    await useRepo.getState().refresh({ prs: false, quiet: true, scope: "all" });

    // A repo switch supersedes the in-flight manual refresh.
    const switched = useRepo.getState().loadRepo("/b");
    slowGraph.resolve(emptyGraph); // the superseded manual refresh resumes and bails
    await switched;
    await manual;
    await new Promise((resolve) => setTimeout(resolve));
    await new Promise((resolve) => setTimeout(resolve));

    // We landed on /b cleanly, and the deferred sync was ultimately replayed there
    // (a second /b graph fetch) rather than silently lost.
    expect(useRepo.getState().summary?.path).toBe("/b");
    expect(useRepo.getState().loading).toBe(false);
    expect(useRepo.getState().graphLoading).toBe(false);
    expect(graphCallsB).toBeGreaterThanOrEqual(2);
  });

  it("registers the filesystem watcher when the shell swaps, before the graph", async () => {
    const graphDeferred = deferred<RepoGraph>();
    let graphPendingAtWatch: boolean | null = null;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "watch_repo") {
        // The watcher is registered while the graph is still loading.
        graphPendingAtWatch =
          useRepo.getState().graph === null && useRepo.getState().graphLoading === true;
        return Promise.resolve(undefined);
      }
      if (cmd === "commit_graph") return graphDeferred.promise;
      return Promise.resolve([]);
    });

    const open = useRepo.getState().loadRepo("/repo");
    await new Promise((resolve) => setTimeout(resolve));

    expect(graphPendingAtWatch).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("watch_repo", { path: "/repo" });

    graphDeferred.resolve(emptyGraph);
    await open;
  });

  it("registers the watcher for the active repo even if the graph fails", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return Promise.reject(new Error("graph boom"));
      return Promise.resolve([]);
    });

    await useRepo.getState().loadRepo("/repo");
    await new Promise((resolve) => setTimeout(resolve));

    // The repo is open (summary published) so it must be watched, and the graph
    // failure still surfaces.
    expect(invokeMock).toHaveBeenCalledWith("watch_repo", { path: "/repo" });
    expect(useRepo.getState().error).toContain("graph boom");
    expect(useRepo.getState().graphLoading).toBe(false);
  });

  it("defers a watcher refresh during a graph load and replays it once loaded", async () => {
    const graphDeferred = deferred<RepoGraph>();
    let graphCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") {
        graphCalls += 1;
        return graphCalls === 1 ? graphDeferred.promise : Promise.resolve(emptyGraph);
      }
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return Promise.resolve([]);
    });
    useRepo.setState({ openPaths: ["/repo"] });

    const open = useRepo.getState().loadRepo("/repo");
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().loading).toBe(true);

    // A filesystem event lands while the graph is still loading: it must not be
    // dropped, but it also must not start a second graph fetch yet (GL-20 review).
    await useRepo.getState().refresh({ prs: false, quiet: true, scope: "all" });
    expect(graphCalls).toBe(1);

    // Finishing the load replays the deferred refresh as a fresh full sync.
    graphDeferred.resolve(emptyGraph);
    await open;
    await new Promise((resolve) => setTimeout(resolve));
    expect(graphCalls).toBeGreaterThanOrEqual(2);
  });

  it("clears the loading flags when the active tab is closed mid graph-load", async () => {
    const graphDeferred = deferred<RepoGraph>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return graphDeferred.promise;
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return Promise.resolve([]);
    });
    useRepo.setState({ openPaths: ["/repo"] });

    const open = useRepo.getState().loadRepo("/repo");
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().loading).toBe(true);
    expect(useRepo.getState().graphLoading).toBe(true);

    await useRepo.getState().closeRepo("/repo");
    expect(useRepo.getState().summary).toBeNull();
    expect(useRepo.getState().loading).toBe(false);
    expect(useRepo.getState().graphLoading).toBe(false);

    // The orphaned graph resolving must not resurrect a loading state.
    graphDeferred.resolve(emptyGraph);
    await open;
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().loading).toBe(false);
    expect(useRepo.getState().graph).toBeNull();
  });

  it("clears the loading flags when closing to a neighbor whose open fails mid-load", async () => {
    const graphDeferred = deferred<RepoGraph>();
    invokeMock.mockImplementation((cmd: string, args: { path?: string }) => {
      if (cmd === "open_repo") {
        return args.path === "/repo"
          ? Promise.resolve(summary)
          : Promise.reject(new Error("neighbor fail"));
      }
      if (cmd === "commit_graph") return graphDeferred.promise;
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return Promise.resolve([]);
    });
    useRepo.setState({ openPaths: ["/repo", "/other"] });

    const open = useRepo.getState().loadRepo("/repo");
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().loading).toBe(true);

    await useRepo.getState().closeRepo("/repo");
    expect(useRepo.getState().openPaths).toEqual(["/other"]);
    expect(useRepo.getState().summary).toBeNull();
    expect(useRepo.getState().error).toContain("neighbor fail");
    expect(useRepo.getState().loading).toBe(false);
    expect(useRepo.getState().graphLoading).toBe(false);

    // The orphaned /repo graph resolving stays a no-op.
    graphDeferred.resolve(emptyGraph);
    await open;
    expect(useRepo.getState().loading).toBe(false);
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

describe("repo store — closeRepo clears forge", () => {
  it("drops the stale forge when the last repo closes", async () => {
    // `forge` keys the provider indicator independently of `summary`, so a leak
    // here would render a stale indicator on the welcome screen.
    const forge: RepoForge = {
      hasRemote: true,
      kind: ForgeKind.GitHub,
      forge: "GitHub",
      host: "github.com",
      webUrl: "https://github.com/o/r",
    };
    useRepo.setState({ openPaths: ["/repo"], summary, forge });

    await useRepo.getState().closeRepo("/repo");

    const s = useRepo.getState();
    expect(s.summary).toBeNull();
    expect(s.forge).toBeNull();
  });
});

describe("repo store — conflict actions", () => {
  it("returns false (and does not throw) when a per-file resolution fails", async () => {
    // A failed git write must report failure so the UI keeps the user's
    // in-progress hunk choices instead of clearing them.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "accept_conflict_side") return Promise.reject(new Error("index.lock"));
      return Promise.resolve([]);
    });
    const ok = await useRepo.getState().acceptConflictSide("src/a.ts", "ours");
    expect(ok).toBe(false);
  });

  it("returns true when a per-file resolution succeeds", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "accept_conflict_side") return Promise.resolve("Resolved");
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      if (cmd === "operation_status")
        return Promise.resolve({ kind: "cherry-pick", canSkip: true, conflicts: [] });
      return Promise.resolve([]);
    });
    const ok = await useRepo.getState().resolveConflictFile("src/a.ts", "merged\n");
    expect(ok).toBe(true);
  });

  it("clears a stale operation when operation_status fails and no conflicts remain", async () => {
    // The conflicted bucket keeps unmerged paths visible independently, so a
    // failed detection with a clean conflict set means the operation is over.
    useRepo.setState({ operation: { kind: "merge", canSkip: false, files: [] } });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "working_changes")
        return Promise.resolve({ staged: [], unstaged: [], conflicted: [] });
      if (cmd === "operation_status") return Promise.reject(new Error("detect failed"));
      return Promise.resolve([]);
    });

    await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });

    expect(useRepo.getState().operation).toBeNull();
  });

  it("keeps the operation when detection fails but conflicts are still present", async () => {
    // A transient operation_status failure mid-resolution must not yank the
    // workspace away while conflicts remain in the worktree.
    const op: OperationState = { kind: "merge", canSkip: false, files: [] };
    useRepo.setState({ operation: op });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "working_changes")
        return Promise.resolve({
          staged: [],
          unstaged: [],
          conflicted: [{ path: "f.txt", status: "C", add: 0, del: 0 }],
        });
      if (cmd === "operation_status") return Promise.reject(new Error("detect failed"));
      return Promise.resolve([]);
    });

    await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });

    expect(useRepo.getState().operation).toBe(op);
  });

  it("does not publish an operation's result onto a repo switched-to mid-await", async () => {
    // Repo A has an active operation; start continue, then switch to repo B
    // (with its own operation) before the git call resolves. The result must
    // not clobber B's state.
    const slow = deferred<string>();
    useRepo.setState({
      summary,
      operation: { kind: "merge", canSkip: false, files: [] },
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "continue_operation") return slow.promise;
      return Promise.resolve([]);
    });

    const pending = useRepo.getState().continueOperation();
    const opB: OperationState = { kind: "rebase", canSkip: true, files: [] };
    useRepo.setState({ summary: { ...summary, path: "/other" }, operation: opB });
    slow.resolve("ok");
    await pending;

    // B's operation is untouched: not cleared, not refreshed away.
    expect(useRepo.getState().summary?.path).toBe("/other");
    expect(useRepo.getState().operation).toBe(opB);
    // And no full refresh ran against B (only the continue_operation call fired).
    expect(invokeMock).not.toHaveBeenCalledWith("commit_graph", expect.anything());
  });
});

describe("repo store — openWorktree", () => {
  const wtSummary: RepoSummary = {
    path: "/repo-wt",
    workdir: "/repo-wt",
    headBranch: "feature",
    headOid: null,
    detached: false,
  };
  // loadRepo would normally park the selection on this tip.
  const graphWithTip: RepoGraph = {
    ...emptyGraph,
    head: "tip",
    commits: [{ id: "tip" }] as unknown as RepoGraph["commits"],
  };

  it("surfaces the WIP node when the opened worktree is dirty", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(wtSummary);
        case "commit_graph":
          return Promise.resolve(graphWithTip);
        case "working_changes":
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "a.ts", status: "M", add: 1, del: 0 }],
            conflicted: [],
          });
        default:
          return Promise.resolve([]);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    // Opening a dirty worktree lands on its working tree, not the tip commit.
    expect(useRepo.getState().wipSelected).toBe(true);
    expect(useRepo.getState().selectedCommit).toBeNull();
  });

  it("keeps loadRepo's tip selection when the opened worktree is clean", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(wtSummary);
        case "commit_graph":
          return Promise.resolve(graphWithTip);
        case "working_changes":
          return Promise.resolve({ staged: [], unstaged: [], conflicted: [] });
        default:
          return Promise.resolve([]);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    expect(useRepo.getState().wipSelected).toBe(false);
    expect(useRepo.getState().selectedCommit).toBe("tip");
  });
});
