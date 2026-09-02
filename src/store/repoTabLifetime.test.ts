import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { emptyAdvancedState } from "@/lib/advancedRepoState";
import type {
  RepoGraph,
  RepoOpenError,
  RepoSummary,
  StashEntry,
  WorkingChanges,
} from "@/lib/api";
import { useRepo } from "./repo";
import { publishRepoSwitch } from "./repoLifecycle/publishSwitch";
import { createInitialRepoData, type RepoDataState } from "./repoTypes";

const EMPTY_CHANGES: WorkingChanges = {
  staged: [],
  unstaged: [],
  conflicted: [],
  advanced: emptyAdvancedState,
};
const EMPTY_GRAPH: RepoGraph = {
  commits: [],
  edges: [],
  laneCount: 1,
  wipLane: null,
  head: null,
  truncated: false,
};

const repo = (path: string, headBranch = "main"): RepoSummary => ({
  path,
  workdir: path,
  headBranch,
  headOid: null,
  detached: false,
});

const missingError = (path: string): RepoOpenError => ({
  kind: "missing",
  message: `This repository can't be found at ${path}.`,
  path,
});

const defaultInvoke = (cmd: string): Promise<unknown> => {
  switch (cmd) {
    case "working_changes":
      return Promise.resolve(EMPTY_CHANGES);
    case "commit_graph":
      return Promise.resolve(EMPTY_GRAPH);
    default:
      return Promise.resolve([]);
  }
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

const tick = () => new Promise<void>((resolve) => setTimeout(resolve));

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => defaultInvoke(cmd));
  localStorage.clear();
  useRepo.setState(createInitialRepoData([]));
});

describe("repo store — pending tab lifetimes", () => {
  it("does not resurrect an existing tab closed while activation resolves", async () => {
    const opened = deferred<RepoSummary>();
    useRepo.setState({
      summary: repo("/a"),
      openPaths: ["/a", "/b"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/b": { isWorktree: false, mainPath: null, branch: "topic" },
      },
    });
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "open_repo" && args?.path === "/b") return opened.promise;
      return defaultInvoke(cmd);
    });

    const activation = useRepo.getState().loadRepo("/b");
    await tick();
    await useRepo.getState().closeRepo("/b");
    opened.resolve(repo("/b", "topic"));
    await activation;
    await tick();

    expect(useRepo.getState().summary?.path).toBe("/a");
    expect(useRepo.getState().openPaths).toEqual(["/a"]);
    expect(invokeMock).not.toHaveBeenCalledWith("watch_repo", { path: "/b" });
  });

  it("does not restore a missing tab when Retry rejects after Remove", async () => {
    const opened = deferred<RepoSummary>();
    useRepo.setState({
      summary: null,
      missingRepo: { path: "/gone", kind: "missing" },
      openPaths: ["/gone"],
      recents: [
        {
          path: "/gone",
          name: "gone",
          branch: "main",
          lastOpenedAt: 1,
          missing: true,
        },
      ],
      tabInfoByPath: {
        "/gone": { isWorktree: false, mainPath: null, branch: "main" },
      },
    });
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "open_repo" && args?.path === "/gone") return opened.promise;
      return defaultInvoke(cmd);
    });

    const retry = useRepo.getState().loadRepo("/gone");
    await tick();
    await useRepo.getState().closeRepo("/gone");
    opened.reject(missingError("/gone"));
    await retry;
    await tick();

    expect(useRepo.getState().openPaths).toEqual([]);
    expect(useRepo.getState().missingRepo).toBeNull();
    expect(useRepo.getState().summary).toBeNull();
    expect(useRepo.getState().error).toBeNull();
  });

  it("does not resurrect the implicit neighbour closed while its open is pending", async () => {
    const opened = deferred<RepoSummary>();
    useRepo.setState({
      summary: repo("/a"),
      openPaths: ["/a", "/b"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/b": { isWorktree: false, mainPath: null, branch: "topic" },
      },
    });
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "open_repo" && args?.path === "/b") return opened.promise;
      return defaultInvoke(cmd);
    });

    const closeActive = useRepo.getState().closeRepo("/a");
    await tick();
    expect(useRepo.getState().summary).toBeNull();
    expect(useRepo.getState().openPaths).toEqual(["/b"]);

    await useRepo.getState().closeRepo("/b");
    opened.resolve(repo("/b", "topic"));
    await closeActive;
    await tick();

    expect(useRepo.getState().summary).toBeNull();
    expect(useRepo.getState().openPaths).toEqual([]);
    expect(localStorage.getItem("gitlane.lastPath")).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("watch_repo", { path: "/b" });
  });

  it("cancels replaceTab when its source tab closes during phase one", async () => {
    const opened = deferred<RepoSummary>();
    useRepo.setState({
      summary: repo("/a"),
      openPaths: ["/a", "/source"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/source": { isWorktree: true, mainPath: "/a", branch: "topic" },
      },
    });
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "open_repo" && args?.path === "/destination") return opened.promise;
      return defaultInvoke(cmd);
    });

    const replacement = useRepo
      .getState()
      .loadRepo("/destination", { replaceTab: "/source" });
    await tick();
    await useRepo.getState().closeRepo("/source");
    opened.resolve(repo("/destination", "new-topic"));
    await replacement;
    await tick();

    expect(useRepo.getState().summary?.path).toBe("/a");
    expect(useRepo.getState().openPaths).toEqual(["/a"]);
    expect(invokeMock).not.toHaveBeenCalledWith("watch_repo", {
      path: "/destination",
    });
  });

  it("lets a new target publish when an unrelated background tab closes", async () => {
    const opened = deferred<RepoSummary>();
    useRepo.setState({
      summary: repo("/a"),
      openPaths: ["/a", "/b"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/b": { isWorktree: false, mainPath: null, branch: "topic" },
      },
    });
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "open_repo" && args?.path === "/c") return opened.promise;
      return defaultInvoke(cmd);
    });

    const opening = useRepo.getState().loadRepo("/c");
    await tick();
    await useRepo.getState().closeRepo("/b");
    opened.resolve(repo("/c", "new"));
    await opening;
    await tick();

    expect(useRepo.getState().summary?.path).toBe("/c");
    expect(useRepo.getState().openPaths).toEqual(["/a", "/c"]);
    expect(invokeMock).toHaveBeenCalledWith("watch_repo", { path: "/c" });
  });

  it("keeps the append fallback when replaceTab names a source that is already absent", async () => {
    useRepo.setState({
      summary: repo("/a"),
      openPaths: ["/a"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
      },
    });
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "open_repo" && args?.path === "/destination") {
        return Promise.resolve(repo("/destination", "topic"));
      }
      return defaultInvoke(cmd);
    });

    await useRepo
      .getState()
      .loadRepo("/destination", { replaceTab: "/already-closed" });

    expect(useRepo.getState().summary?.path).toBe("/destination");
    expect(useRepo.getState().openPaths).toEqual(["/a", "/destination"]);
  });

  it("does not resurrect an existing canonical tab opened through an alternate path", async () => {
    const opened = deferred<RepoSummary>();
    useRepo.setState({
      summary: repo("/a"),
      openPaths: ["/a", "/canonical-b"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/canonical-b": { isWorktree: false, mainPath: null, branch: "topic" },
      },
    });
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "open_repo" && args?.path === "/canonical-b/subdir") {
        return opened.promise;
      }
      return defaultInvoke(cmd);
    });

    const activation = useRepo.getState().loadRepo("/canonical-b/subdir");
    await tick();
    await useRepo.getState().closeRepo("/canonical-b");
    opened.resolve(repo("/canonical-b", "topic"));
    await activation;

    expect(useRepo.getState().summary?.path).toBe("/a");
    expect(useRepo.getState().openPaths).toEqual(["/a"]);
    expect(invokeMock).not.toHaveBeenCalledWith("watch_repo", {
      path: "/canonical-b",
    });
  });

  it("allows only the newer load to publish after a same-path close and reopen", async () => {
    const firstOpen = deferred<RepoSummary>();
    const secondOpen = deferred<RepoSummary>();
    let bOpenCalls = 0;
    useRepo.setState({
      summary: repo("/a"),
      openPaths: ["/a", "/b"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/b": { isWorktree: false, mainPath: null, branch: "before" },
      },
    });
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "open_repo" && args?.path === "/b") {
        bOpenCalls += 1;
        return bOpenCalls === 1 ? firstOpen.promise : secondOpen.promise;
      }
      return defaultInvoke(cmd);
    });

    const oldActivation = useRepo.getState().loadRepo("/b");
    await tick();
    await useRepo.getState().closeRepo("/b");
    const reopened = useRepo.getState().loadRepo("/b");
    await tick();

    secondOpen.resolve(repo("/b", "fresh"));
    await reopened;
    firstOpen.resolve(repo("/b", "stale"));
    await oldActivation;
    await tick();

    expect(useRepo.getState().summary?.path).toBe("/b");
    expect(useRepo.getState().summary?.headBranch).toBe("fresh");
    expect(useRepo.getState().openPaths).toEqual(["/a", "/b"]);
  });

  it("drops an old refreshTabInfo result after same-path close and reopen", async () => {
    const statusProbe = deferred<
      Array<{
        path: string;
        exists: boolean;
        branch: string;
        isWorktree: boolean;
        mainPath: string | null;
      }>
    >();
    useRepo.setState({
      summary: repo("/a"),
      openPaths: ["/a", "/b"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/b": { isWorktree: false, mainPath: null, branch: "before" },
      },
    });
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "recents_status") return statusProbe.promise;
      if (cmd === "open_repo" && args?.path === "/b") {
        return Promise.resolve(repo("/b", "fresh"));
      }
      return defaultInvoke(cmd);
    });

    const oldRefresh = useRepo.getState().refreshTabInfo("/b");
    await tick();
    await useRepo.getState().closeRepo("/b");
    await useRepo.getState().loadRepo("/b");

    statusProbe.resolve([
      {
        path: "/b",
        exists: true,
        branch: "stale",
        isWorktree: false,
        mainPath: null,
      },
    ]);
    await oldRefresh;

    expect(useRepo.getState().tabInfoByPath["/b"]?.branch).toBe("fresh");
  });
});

// GL-373 block 01 — wipe completeness. Every site that drops a repo's data
// (close last tab, close-to-neighbour, enter missing-repo state, removed
// worktree with nothing to land on, publish a switch) must cover every
// `RepoDataState` field: a field added to the state without a wipe value
// fails here. The preserve list is the site's explicit set of carried-across
// or site-specific keys; everything else must equal the initial value.
describe("repo store — wipe completeness", () => {
  const STASH: StashEntry = {
    index: 0,
    message: "stash",
    oid: "stash-oid",
    timestamp: 1,
    baseOid: null,
    baseTimestamp: null,
    context: [],
  };

  // Keys every wipe site deliberately carries across: transport bookkeeping
  // (the transport still owns live remote work after its tab closes), the
  // startup-restore phase, the missing-repo init flag, the recents list, and
  // the monotonic selection id (resetting it could alias an in-flight
  // selection request).
  const CARRIED_ACROSS: (keyof RepoDataState)[] = [
    "netOps",
    "fetchingPath",
    "sessionRestorePhase",
    "initMissingRepoRunning",
    "recents",
    "fileSelectionRequestId",
  ];

  // Dirty every field a wipe must reset, plus the carried-across ones so a
  // site that wipes one of those by mistake fails too.
  const dirty = {
    stashes: [STASH],
    wipSelected: true,
    error: "stale error",
    diffLoading: true,
    loading: true,
    graphLoading: true,
    loadingMoreHistory: true,
    selectedCommit: "deadbeef",
    selectedCommits: ["deadbeef"],
    inspectParentIndex: 3,
    selectionAnchor: "deadbeef",
    reflogError: "stale reflog",
    reflogLoading: true,
    graphLimit: 9999,
    netOps: 2,
    fetchingPath: "/busy",
    fileSelectionRequestId: 7,
    initMissingRepoRunning: true,
  };

  function expectRepoDataWiped(preserve: readonly (keyof RepoDataState)[]) {
    const state = useRepo.getState();
    const initial = createInitialRepoData(state.openPaths);
    for (const key of Object.keys(initial) as (keyof RepoDataState)[]) {
      if (preserve.includes(key)) continue;
      expect(state[key], `field not wiped: ${key}`).toStrictEqual(initial[key]);
    }
  }

  it("closing the last tab wipes every repo data field", async () => {
    useRepo.setState({
      summary: repo("/a"),
      openPaths: ["/a"],
      tabInfoByPath: { "/a": { isWorktree: false, mainPath: null, branch: "main" } },
      ...dirty,
    });

    await useRepo.getState().closeRepo("/a");

    expect(useRepo.getState().openPaths).toEqual([]);
    expectRepoDataWiped(CARRIED_ACROSS);
  });

  it("closing into a neighbour tab wipes every repo data field", async () => {
    const opened = deferred<RepoSummary>();
    useRepo.setState({
      summary: repo("/a"),
      openPaths: ["/a", "/b"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/b": { isWorktree: false, mainPath: null, branch: "topic" },
      },
      ...dirty,
    });
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "open_repo" && args?.path === "/b") return opened.promise;
      return defaultInvoke(cmd);
    });

    const closing = useRepo.getState().closeRepo("/a");
    await tick();

    expect(useRepo.getState().openPaths).toEqual(["/b"]);
    expectRepoDataWiped([...CARRIED_ACROSS, "tabInfoByPath"]);
    opened.resolve(repo("/b", "topic"));
    await closing;
  });

  it("entering the missing-repo state wipes every repo data field", async () => {
    // The other tabs' info must survive: it describes the tab strip, not the
    // repo that just went missing.
    const otherTabs = { "/b": { isWorktree: true, mainPath: "/main", branch: "topic" } };
    useRepo.setState({ openPaths: [], tabInfoByPath: otherTabs, ...dirty });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "open_repo"
        ? Promise.reject(missingError("/gone"))
        : defaultInvoke(cmd),
    );

    await useRepo.getState().loadRepo("/gone");

    expect(useRepo.getState().missingRepo).toEqual({ path: "/gone", kind: "missing" });
    expect(useRepo.getState().openPaths).toEqual(["/gone"]);
    expect(useRepo.getState().tabInfoByPath).toStrictEqual(otherTabs);
    expectRepoDataWiped([...CARRIED_ACROSS, "missingRepo", "tabInfoByPath"]);
  });

  it("a removed worktree with nothing to land on wipes every repo data field", async () => {
    useRepo.setState({
      summary: { ...repo("/wt"), isWorktree: true, mainPath: "/main" },
      openPaths: ["/wt"],
      tabInfoByPath: { "/wt": { isWorktree: true, mainPath: null, branch: "topic" } },
      ...dirty,
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "open_repo"
        ? Promise.reject(missingError("/wt"))
        : defaultInvoke(cmd),
    );

    await useRepo.getState().loadRepo("/wt");

    expect(useRepo.getState().openPaths).toEqual([]);
    expect(useRepo.getState().missingRepo).toBeNull();
    expectRepoDataWiped(CARRIED_ACROSS);
  });

  it("publishing a repo switch wipes every repo data field", () => {
    // Secondary reads start landing right after the switch publishes, so the
    // post-state can't be compared against the initial shape — assert on the
    // publish itself: it must cover every field.
    useRepo.setState({ openPaths: [], ...dirty });
    const published: string[] = [];
    const set = ((partial: Record<string, unknown>) => {
      published.push(...Object.keys(partial));
      useRepo.setState(partial as Partial<RepoDataState>);
    }) as unknown as Parameters<typeof publishRepoSwitch>[0];

    publishRepoSwitch(set, useRepo.getState, repo("/b", "topic"), undefined, null);

    expect(useRepo.getState().summary?.path).toBe("/b");
    const carriedOrDeltas = [
      ...CARRIED_ACROSS,
      "summary",
      "loading",
      "graphLoading",
      "tabInfoByPath",
    ];
    for (const key of Object.keys(createInitialRepoData([])) as (keyof RepoDataState)[]) {
      if (carriedOrDeltas.includes(key)) continue;
      expect(published, `field missing from the switch publish: ${key}`).toContain(key);
    }
  });
});
