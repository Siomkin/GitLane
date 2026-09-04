// Opening a repository: the progressive open sequence and its failure paths.
//
// Split out of the former src/store/repo.test.ts, which reached 5 122 lines;
// shared data fixtures live in @/test/repoFixtures.

import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { seedPrResource } from "@/test/prResources";
import { PR_RESOURCE } from "@/store/pullsResource";
import { usePulls } from "@/store/pulls";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the IPC boundary so the store's async actions run headlessly. `vi.mock`
// is hoisted above the import below; `vi.hoisted` makes `invokeMock` exist in time.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRepo } from "@/store/repo";
import { useUi, fileMenuOf, FileMenuKind, MenuKind } from "@/store/ui";
import { EMPTY_CHANGES, defaultInvoke, deferred, emptyGraph, node, summary } from "@/test/repoFixtures";
import type { PrDetail, PrSummary } from "@/lib/prs";
import type {
  BranchInfo,
  RepoGraph,
  RepoSummary,
  StashEntry,
  WorkingChanges,
  WorktreeInfo,
} from "@/lib/api";

const realRefresh = useRepo.getState().refresh;
beforeEach(() => {
  invokeMock.mockReset();
  // Fire-and-forget IPC (e.g. watch/unwatch on tab open/close) must resolve
  // rather than return `undefined`, and every wrapper now validates its result
  // (GL-57) — so answer each command's schema-valid empty payload (a "" status
  // for writes); tests that care set their own impl.
  invokeMock.mockImplementation(emptyIpcInvoke);
  useRepo.setState({
    summary,
    selectedFile: null,
    fileSelectionRequestId: 0,
    fileDiff: null,
    selectedCommit: null,
    inspectParentIndex: 0,
    graphLimit: 2_000,
    loadingMoreHistory: false,
    fetchingPath: null,
    refresh: realRefresh,
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
      { name: "main", kind: "local", target: "abc1234", isHead: true, upstream: null, remote: null },
    ];
    const prevWorktrees: WorktreeInfo[] = [
      { name: "old", path: "/old", branch: "main", isMain: true },
    ];
    const prevStashes: StashEntry[] = [
      { index: 0, message: "wip", oid: "s1", timestamp: 0, baseOid: "abc1234", baseTimestamp: 0, context: [] },
    ];
    const prevChanges: WorkingChanges = {
      staged: [{ path: "a.ts", status: "M", add: 1, del: 0, binary: false }],
      unstaged: [],
      conflicted: [],
      advanced: emptyAdvancedState,
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
  it("clears a repo-bound menu opened while the next repo is still resolving", async () => {
    const nextSummary: RepoSummary = {
      path: "/other",
      workdir: "/other",
      headBranch: "main",
      headOid: null,
      detached: false,
    };
    const opened = deferred<RepoSummary>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return opened.promise;
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      return defaultInvoke(cmd);
    });

    const switching = useRepo.getState().loadRepo("/other");
    await Promise.resolve();
    // The old repo remains interactive during phase one. This payload is valid
    // there, but must not survive the atomic publication of `/other`.
    useUi.setState({
      menu: {
        kind: MenuKind.File,
        state: { kind: FileMenuKind.Working, x: 10, y: 10, path: "shared.txt", discard: { staged: false } },
      },
    });

    opened.resolve(nextSummary);
    await switching;

    expect(useRepo.getState().summary).toEqual(nextSummary);
    expect(fileMenuOf(useUi.getState())).toBeNull();
  });

  it("resets stale PR state before the commit graph resolves", async () => {
    // A previous repo's PRs are still in the store when a new open begins.
    usePulls.setState({ pullRequests: [{ num: 99 } as unknown as PrSummary], prError: "stale error", prsFetchedAt: 123 });
    seedPrResource(PR_RESOURCE.Detail, { data: { 99: { num: 99 } as unknown as PrDetail } });

    // Hold the graph open: its payload is the slow part of an open, so this is
    // exactly the window where the ActionBar could pair the new summary with the
    // old repo's PRs (GL-20 review fix).
    const graphDeferred = deferred<RepoGraph>();
    let prsAtGraphCall: PrSummary[] | null = null;
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
          return defaultInvoke(cmd);
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
        node({ id: "s0", stash: { index: 0, message: "WIP" } }),
        node({ id: "real-tip" }),
      ],
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
          return defaultInvoke(cmd);
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
          return defaultInvoke(cmd);
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
          return defaultInvoke(cmd);
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
          return defaultInvoke(cmd);
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
      return defaultInvoke(cmd);
    });

    // Open A; park it on the (still-pending) graph load.
    const openA = useRepo.getState().loadRepo("/a");
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().summary).toEqual(summaryA);
    expect(useRepo.getState().graphLoading).toBe(true);

    // A second pick fails at open_repo. It must surface its error WITHOUT
    // superseding A's load — no generation bump, no flag changes (GL-20 review).
    await useRepo.getState().loadRepo("/does-not-exist");
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().error).toContain("bad pick");
    expect(useRepo.getState().summary).toEqual(summaryA);
    expect(useRepo.getState().graphLoading).toBe(true);
    expect(useRepo.getState().loading).toBe(true);

    // A's graph resolves and still paints — it was never orphaned.
    graphA.resolve(emptyGraph);
    await openA;
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().graph).toEqual(emptyGraph);
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
      return defaultInvoke(cmd);
    });

    // Pick A (its open hangs), then immediately pick B (opens fast → becomes active).
    const loadA = useRepo.getState().loadRepo("/a");
    await useRepo.getState().loadRepo("/b");
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().summary).toEqual(summaryB);

    // A's open finally resolves — as the superseded pick it must NOT publish over B.
    openA.resolve(summaryA);
    await loadA;
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().summary).toEqual(summaryB);
    expect(useRepo.getState().graph).toEqual(emptyGraph);
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
      return defaultInvoke(cmd);
    });

    // Pick a bad repo whose open hangs, then pick B which opens and becomes active.
    const loadBad = useRepo.getState().loadRepo("/bad");
    await useRepo.getState().loadRepo("/b");
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().summary).toEqual(summaryB);
    expect(useRepo.getState().error).toBeNull();

    // The older bad open finally rejects — it must NOT surface an error over B.
    openBad.reject(new Error("bad pick"));
    await loadBad;
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().error).toBeNull();
    expect(useRepo.getState().summary).toEqual(summaryB);
  });

  it("honors a branch picked during the load instead of snapping to the tip", async () => {
    const loadedGraph: RepoGraph = {
      commits: [
        { id: "head", shortId: "head", summary: "head", body: "", authorName: "", authorEmail: "", timestamp: 0, parents: [], lane: 0, row: 0, refs: [] },
        { id: "tip", shortId: "tip", summary: "feat", body: "", authorName: "", authorEmail: "", timestamp: 0, parents: ["head"], lane: 0, row: 1, refs: [] },
      ],
      edges: [],
      laneCount: 1,
      wipLane: null,
      head: "head",
      truncated: false,
    };
    const graphDeferred = deferred<RepoGraph>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return graphDeferred.promise;
      if (cmd === "commit_files") return Promise.resolve([{ path: "f.ts", status: "M", add: 1, del: 0, binary: false }]);
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return defaultInvoke(cmd);
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
        { id: "head", shortId: "head", summary: "head", body: "", authorName: "", authorEmail: "", timestamp: 0, parents: [], lane: 0, row: 0, refs: [] },
        { id: "tip", shortId: "tip", summary: "feat", body: "", authorName: "", authorEmail: "", timestamp: 0, parents: ["head"], lane: 0, row: 1, refs: [] },
      ],
      edges: [],
      laneCount: 1,
      wipLane: null,
      head: "head",
      truncated: true,
    };
    const graphDeferred = deferred<RepoGraph>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return graphDeferred.promise;
      if (cmd === "commit_files") return Promise.resolve([{ path: "f.ts", status: "M", add: 1, del: 0, binary: false }]);
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return defaultInvoke(cmd);
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
      return defaultInvoke(cmd);
    });
    useRepo.setState({ openPaths: ["/repo"], branches: [] });

    // Open completes (graph lands) while the branches read is still in flight.
    await useRepo.getState().loadRepo("/repo");
    // An unrelated "load more" bumps the graph generation mid-flight.
    await useRepo.getState().loadMoreHistory();

    const picked: BranchInfo[] = [
      { name: "main", kind: "local", target: "head", isHead: true, upstream: null, remote: null },
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
      return defaultInvoke(cmd);
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

  it("asks (reclaim here vs open) instead of silently entering the worktree holding the branch", async () => {
    const realOpenWorktree = useRepo.getState().openWorktree;
    const openWorktree = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      summary: { ...summary, headBranch: null, detached: true },
      worktrees: [
        { name: "repo", path: "/repo", branch: null, isMain: true },
        { name: "zen-chaum-e0e8aa", path: "/repo/.claude/worktrees/zen-chaum-e0e8aa", branch: "develop", isMain: false },
      ],
      openWorktree,
    });

    try {
      const message = await useRepo.getState().checkoutBranch("develop");

      // The dialog owns what happens next — no checkout, no tab switch, no toast.
      expect(message).toBe("");
      expect(openWorktree).not.toHaveBeenCalled();
      expect(invokeMock).not.toHaveBeenCalledWith("checkout", expect.anything());
      const confirm = useUi.getState().confirm;
      expect(confirm?.title).toBe("develop is in another worktree");
      // The holding worktree is named with its full path — the user must be
      // able to SEE what blocks the checkout.
      expect(confirm?.details).toEqual(["/repo/.claude/worktrees/zen-chaum-e0e8aa"]);

      // Primary: reclaim the branch here — the hand-off dialog opens with the
      // open worktree preselected as the destination.
      confirm?.onConfirm();
      expect(useUi.getState().handoff).toEqual({
        branch: "develop",
        sourcePath: "/repo/.claude/worktrees/zen-chaum-e0e8aa",
        sourceChanges: null,
        destPath: "/repo",
      });

      // Secondary: open the holding worktree (the old reroute, now opt-in).
      confirm?.secondary?.onClick();
      expect(confirm?.secondary?.label).toBe("Open that worktree");
      expect(openWorktree).toHaveBeenCalledWith("/repo/.claude/worktrees/zen-chaum-e0e8aa");
    } finally {
      useRepo.setState({ openWorktree: realOpenWorktree });
      useUi.setState({ confirm: null, handoff: null });
    }
  });

  it("re-validates live state when the reclaim confirm is accepted after a worktree change", async () => {
    const realOpenWorktree = useRepo.getState().openWorktree;
    const openWorktree = vi.fn().mockResolvedValue(undefined);
    const showToast = vi.fn();
    const originalShowToast = useUi.getState().showToast;
    useUi.setState({ showToast });
    useRepo.setState({
      summary: { ...summary, headBranch: null, detached: true },
      worktrees: [
        { name: "repo", path: "/repo", branch: null, isMain: true },
        { name: "zen-chaum-e0e8aa", path: "/repo/.claude/worktrees/zen-chaum-e0e8aa", branch: "develop", isMain: false },
      ],
      openWorktree,
    });

    try {
      await useRepo.getState().checkoutBranch("develop");
      const confirm = useUi.getState().confirm;
      expect(confirm?.title).toBe("develop is in another worktree");

      // The confirm sits open while a watcher refresh moves the branch out of
      // the holder — accepting must NOT start a handoff from the stale snapshot.
      useRepo.setState({
        worktrees: [
          { name: "repo", path: "/repo", branch: null, isMain: true },
          { name: "zen-chaum-e0e8aa", path: "/repo/.claude/worktrees/zen-chaum-e0e8aa", branch: null, isMain: false },
        ],
      });
      confirm?.onConfirm();

      expect(useUi.getState().handoff).toBeNull();
      expect(showToast).toHaveBeenCalledWith(
        "develop moved while the dialog was open. Try again.",
        "error",
      );
    } finally {
      useRepo.setState({ openWorktree: realOpenWorktree });
      useUi.setState({ confirm: null, handoff: null, showToast: originalShowToast });
    }
  });

  it("falls back to opening the holding worktree when the open repo can't take the branch", async () => {
    const realOpenWorktree = useRepo.getState().openWorktree;
    const openWorktree = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      summary: { ...summary, headBranch: null, detached: true },
      worktrees: [
        // A bare main checkout is not a valid hand-off destination, so the
        // reclaim dialog can't be offered — keep the old open-reroute.
        { name: "repo", path: "/repo", branch: null, isMain: true, bare: true },
        { name: "zen-chaum-e0e8aa", path: "/repo/.claude/worktrees/zen-chaum-e0e8aa", branch: "develop", isMain: false },
      ],
      openWorktree,
    });

    try {
      const message = await useRepo.getState().checkoutBranch("develop");

      expect(message).toBe("Opened develop worktree");
      expect(openWorktree).toHaveBeenCalledWith("/repo/.claude/worktrees/zen-chaum-e0e8aa");
      expect(useUi.getState().confirm).toBeNull();
      expect(invokeMock).not.toHaveBeenCalledWith("checkout", expect.anything());
    } finally {
      useRepo.setState({ openWorktree: realOpenWorktree });
    }
  });

  it("refreshes worktree ownership before checking out when the cached list is empty", async () => {
    const realOpenWorktree = useRepo.getState().openWorktree;
    const openWorktree = vi.fn().mockResolvedValue(undefined);
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_worktrees") {
        return Promise.resolve([
          { name: "repo", path: "/repo", branch: null, isMain: true },
          { name: "zen-chaum-e0e8aa", path: "/repo/.claude/worktrees/zen-chaum-e0e8aa", branch: "develop", isMain: false },
        ]);
      }
      return defaultInvoke(cmd);
    });
    useRepo.setState({
      summary: { ...summary, headBranch: null, detached: true },
      worktrees: [],
      openWorktree,
    });

    try {
      await useRepo.getState().checkoutBranch("develop");

      expect(invokeMock).toHaveBeenCalledWith("list_worktrees", { path: "/repo" });
      expect(useRepo.getState().worktrees).toHaveLength(2);
      // The freshly-discovered holder raises the same reclaim dialog.
      expect(openWorktree).not.toHaveBeenCalled();
      expect(useUi.getState().confirm?.title).toBe("develop is in another worktree");
      expect(invokeMock).not.toHaveBeenCalledWith("checkout", expect.anything());
    } finally {
      useRepo.setState({ openWorktree: realOpenWorktree });
      useUi.setState({ confirm: null });
    }
  });

  it("creates a tracking local branch when checking out a remote branch", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      if (cmd === "working_changes") return Promise.resolve(EMPTY_CHANGES);
      return defaultInvoke(cmd);
    });
    useRepo.setState({ summary, graph: emptyGraph, loading: false, worktrees: [] });

    await useRepo.getState().checkoutRemoteBranch("origin", "feature");

    expect(invokeMock).toHaveBeenCalledWith("list_worktrees", { path: "/repo" });
    expect(invokeMock).toHaveBeenCalledWith("checkout_remote_branch", {
      path: "/repo",
      remote: "origin",
      branch: "feature",
    });
    expect(useRepo.getState().loading).toBe(false);
  });

  it("fast-forwards a remote branch in its existing worktree before opening it", async () => {
    const realOpenWorktree = useRepo.getState().openWorktree;
    const openWorktree = vi.fn().mockResolvedValue(undefined);
    const worktreePath = "/repo/.claude/worktrees/feature";
    useRepo.setState({
      summary,
      graph: emptyGraph,
      loading: false,
      worktrees: [
        { name: "repo", path: "/repo", branch: "main", isMain: true },
        { name: "feature", path: worktreePath, branch: "feature", isMain: false },
      ],
      openWorktree,
    });

    try {
      await useRepo.getState().checkoutRemoteBranch("origin", "feature");

      expect(invokeMock).toHaveBeenCalledWith("checkout_remote_branch", {
        path: worktreePath,
        remote: "origin",
        branch: "feature",
      });
      expect(openWorktree).toHaveBeenCalledWith(worktreePath);
      expect(useRepo.getState().loading).toBe(false);
    } finally {
      useRepo.setState({ openWorktree: realOpenWorktree });
    }
  });

  it("refreshes after remote checkout reports a partial failure", async () => {
    let graphCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "checkout_remote_branch") {
        return Promise.reject(new Error("feature is checked out, but it couldn't be fast-forwarded"));
      }
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") {
        graphCalls += 1;
        return Promise.resolve(emptyGraph);
      }
      if (cmd === "working_changes") return Promise.resolve(EMPTY_CHANGES);
      return defaultInvoke(cmd);
    });
    useRepo.setState({ summary, graph: emptyGraph, loading: false, worktrees: [] });

    await expect(
      useRepo.getState().checkoutRemoteBranch("origin", "feature"),
    ).rejects.toThrow("feature is checked out");

    expect(graphCalls).toBeGreaterThanOrEqual(1);
    expect(useRepo.getState().loading).toBe(false);
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
      return defaultInvoke(cmd);
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
      return defaultInvoke(cmd);
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
      return defaultInvoke(cmd);
    });

    await useRepo.getState().loadRepo("/repo");
    await new Promise((resolve) => setTimeout(resolve));

    // The repo is open (summary published) so it must be watched, and the graph
    // failure still surfaces.
    expect(invokeMock).toHaveBeenCalledWith("watch_repo", { path: "/repo" });
    expect(useRepo.getState().error).toContain("graph boom");
    expect(useRepo.getState().graphLoading).toBe(false);
  });

  it("releases the replaced tab's watch on an in-place worktree switch (GL-116)", async () => {
    // The GL-110 in-place switch re-keys the tab from /old to /new; the per-tab
    // watcher map is keyed by path, so the /old watch must be released or it
    // leaks for the rest of the session.
    useRepo.setState({ summary: { ...summary, path: "/old" }, openPaths: ["/old"] });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve({ ...summary, path: "/new", workdir: "/new" });
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      return defaultInvoke(cmd);
    });

    await useRepo.getState().loadRepo("/new", { replaceTab: "/old" });
    await new Promise((resolve) => setTimeout(resolve));

    expect(useRepo.getState().openPaths).toEqual(["/new"]);
    expect(invokeMock).toHaveBeenCalledWith("watch_repo", { path: "/new" });
    expect(invokeMock).toHaveBeenCalledWith("unwatch_repo", { path: "/old" });
  });

  it("keeps the watch when replaceTab resolves to the same path (GL-116)", async () => {
    // A re-open of the already-active path must not unwatch the tab it just
    // re-armed (old === new key).
    useRepo.setState({ summary: { ...summary, path: "/repo" }, openPaths: ["/repo"] });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      return defaultInvoke(cmd);
    });

    await useRepo.getState().loadRepo("/repo", { replaceTab: "/repo" });
    await new Promise((resolve) => setTimeout(resolve));

    expect(invokeMock).not.toHaveBeenCalledWith("unwatch_repo", { path: "/repo" });
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
      return defaultInvoke(cmd);
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
      return defaultInvoke(cmd);
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
      return defaultInvoke(cmd);
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
