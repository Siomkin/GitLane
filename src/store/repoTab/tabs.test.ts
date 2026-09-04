// Tab strip behaviour: order, closing, overlays, and background-tab labels.
//
// Split out of the former src/store/repo.test.ts, which reached 5 122 lines;
// shared data fixtures live in @/test/repoFixtures.

import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the IPC boundary so the store's async actions run headlessly. `vi.mock`
// is hoisted above the import below; `vi.hoisted` makes `invokeMock` exist in time.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { defaultInvoke, deferred, emptyGraph, summary } from "@/test/repoFixtures";
import type {
  RepoSummary,
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

describe("repo store — hand-off overlay lifecycle", () => {
  const openHandoffDialog = () =>
    useUi.setState({
      handoff: { branch: "feature", sourcePath: "/repo-feature", sourceChanges: 1 },
      handoffRunning: false,
    });
  const switchInvoke = (path: string) => (cmd: string) => {
    if (cmd === "open_repo") return Promise.resolve({ ...summary, path, workdir: path });
    if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
    return defaultInvoke(cmd);
  };

  it("closes a stale hand-off dialog on a genuine repo switch", async () => {
    openHandoffDialog();
    invokeMock.mockImplementation(switchInvoke("/other"));
    await useRepo.getState().loadRepo("/other");
    expect(useUi.getState().handoff).toBeNull();
  });

  it("keeps the dialog through the hand-off's own destination load", async () => {
    openHandoffDialog();
    useUi.setState({ handoffRunning: true });
    invokeMock.mockImplementation(switchInvoke("/dest"));
    await useRepo.getState().loadRepo("/dest");
    expect(useUi.getState().handoff).not.toBeNull();
    useUi.setState({ handoff: null, handoffRunning: false });
  });

  it("closes the dialog when the last tab closes", async () => {
    openHandoffDialog();
    useRepo.setState({ summary, openPaths: ["/repo"] });
    await useRepo.getState().closeRepo("/repo");
    expect(useUi.getState().handoff).toBeNull();
  });

  // A dismissed dialog leaves the move running in the background; if the user
  // then closes every tab, landing on the destination would yank the app off
  // the welcome screen they chose — the result reaches them as a toast instead.
  it("skips reopening the destination when every tab closed mid-move", async () => {
    const slowMove = deferred<string>();
    useRepo.setState({ summary, openPaths: ["/repo"], loading: false });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "move_branch_to_worktree") return slowMove.promise;
      if (cmd === "open_repo") return Promise.resolve(summary);
      return defaultInvoke(cmd);
    });

    const move = useRepo
      .getState()
      .moveBranchToWorktree("feature", "/repo-feature", "/repo", true);
    await useRepo.getState().closeRepo("/repo");
    slowMove.resolve("Moved feature to repo");

    await expect(move).resolves.toBe("Moved feature to repo");
    expect(invokeMock).not.toHaveBeenCalledWith("open_repo", expect.anything());
    expect(useRepo.getState().summary).toBeNull();
    expect(useRepo.getState().loading).toBe(false);
  });
});

// The delete-branch-and-worktree dialog is repo-bound like confirm/prompt, but —
// unlike hand-off — it never switches repos itself (success refreshes the same
// repo). So ANY genuine switch must clear it, running or not; an in-flight delete
// keeps going and reports via toast (GL-107).

describe("repo store — delete-worktree overlay lifecycle", () => {
  const openDeleteDialog = () =>
    useUi.setState({
      deleteWorktree: { branch: "feature", worktreePath: "/repo-feature" },
      deleteWorktreeRunning: false,
    });
  const switchInvoke = (path: string) => (cmd: string) => {
    if (cmd === "open_repo") return Promise.resolve({ ...summary, path, workdir: path });
    if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
    return defaultInvoke(cmd);
  };

  it("closes the delete dialog on a genuine repo switch", async () => {
    openDeleteDialog();
    invokeMock.mockImplementation(switchInvoke("/other"));
    await useRepo.getState().loadRepo("/other");
    expect(useUi.getState().deleteWorktree).toBeNull();
  });

  it("closes it even while a delete is in flight (the run reports via toast)", async () => {
    openDeleteDialog();
    useUi.setState({ deleteWorktreeRunning: true });
    invokeMock.mockImplementation(switchInvoke("/other"));
    await useRepo.getState().loadRepo("/other");
    expect(useUi.getState().deleteWorktree).toBeNull();
    useUi.setState({ deleteWorktreeRunning: false });
  });

  it("closes the dialog when the last tab closes", async () => {
    openDeleteDialog();
    useRepo.setState({ summary, openPaths: ["/repo"] });
    await useRepo.getState().closeRepo("/repo");
    expect(useUi.getState().deleteWorktree).toBeNull();
  });
});

describe("repo store — closing beside a collapsed group", () => {
  it("lands on the next drawn tab, not one folded away inside a collapsed group", async () => {
    localStorage.clear();
    // Drawn as `[Acme collapsed: /a1 /a2] /notes /desktop`, with /notes active.
    useUi.setState({
      repoGroups: [{ id: "g1", name: "Acme", color: "blue" }],
      repoLabelsByIdentity: { "/a1": { groupId: "g1" }, "/a2": { groupId: "g1" } },
      collapsedRepoGroups: ["g1"],
    });
    useRepo.setState({
      summary: { ...summary, path: "/notes" },
      openPaths: ["/a1", "/notes", "/a2", "/desktop"],
      tabInfoByPath: {},
    });

    // The neighbour's open is irrelevant here — only which tab is picked is.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "open_repo" ? Promise.resolve({ ...summary, path: "/desktop" }) : defaultInvoke(cmd),
    );

    await useRepo.getState().closeRepo("/notes");

    // /notes was the only drawn tab before /desktop, so the neighbour pick
    // falls through to /desktop rather than reaching into the folded group.
    expect(useRepo.getState().openPaths).toEqual(["/a1", "/a2", "/desktop"]);
    expect(localStorage.getItem("gitlane.lastPath")).toBe("/desktop");
  });

  it("lands on the tab to the left once the group is expanded", async () => {
    localStorage.clear();
    useUi.setState({
      repoGroups: [{ id: "g1", name: "Acme", color: "blue" }],
      repoLabelsByIdentity: { "/a1": { groupId: "g1" }, "/a2": { groupId: "g1" } },
      collapsedRepoGroups: [],
    });
    useRepo.setState({
      summary: { ...summary, path: "/notes" },
      openPaths: ["/a1", "/notes", "/a2", "/desktop"],
      tabInfoByPath: {},
    });

    invokeMock.mockImplementation((cmd: string) =>
      cmd === "open_repo" ? Promise.resolve({ ...summary, path: "/a2" }) : defaultInvoke(cmd),
    );

    await useRepo.getState().closeRepo("/notes");

    expect(localStorage.getItem("gitlane.lastPath")).toBe("/a2");
  });
});

describe("repo store — setTabOrder", () => {
  it("accepts a permutation of the open tabs and persists it", () => {
    localStorage.clear();
    useRepo.setState({ summary: { ...summary, path: "/b" }, openPaths: ["/a", "/b", "/c"] });

    useRepo.getState().setTabOrder(["/c", "/a", "/b"]);

    expect(useRepo.getState().openPaths).toEqual(["/c", "/a", "/b"]);
    expect(JSON.parse(localStorage.getItem("gitlane.openPaths:v1") ?? "[]")).toEqual([
      "/c",
      "/a",
      "/b",
    ]);
    expect(localStorage.getItem("gitlane.lastPath")).toBe("/b");
  });

  it("rejects an order that drops, adds, or duplicates a tab", () => {
    localStorage.clear();
    useRepo.setState({ summary, openPaths: ["/a", "/b", "/c"] });

    useRepo.getState().setTabOrder(["/a", "/b"]);
    useRepo.getState().setTabOrder(["/a", "/b", "/c", "/d"]);
    useRepo.getState().setTabOrder(["/a", "/a", "/b"]);
    useRepo.getState().setTabOrder(["/a", "/b", "/d"]);

    expect(useRepo.getState().openPaths).toEqual(["/a", "/b", "/c"]);
    expect(localStorage.getItem("gitlane.openPaths:v1")).toBeNull();
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
    expect(JSON.parse(localStorage.getItem("gitlane.openPaths:v1") ?? "[]")).toEqual([
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
    expect(JSON.parse(localStorage.getItem("gitlane.openPaths:v1") ?? "[]")).toEqual([
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
    expect(localStorage.getItem("gitlane.openPaths:v1")).toBeNull();
  });
});

describe("repo store — worktree tabs (GL-110)", () => {
  const mainSummary: RepoSummary = {
    path: "/repo",
    workdir: "/repo",
    headBranch: "main",
    headOid: null,
    detached: false,
    isWorktree: false,
    mainPath: null,
  };
  const wtSummary: RepoSummary = {
    path: "/repo/.claude/worktrees/lewin",
    workdir: "/repo/.claude/worktrees/lewin",
    headBranch: "d/lewin",
    headOid: null,
    detached: false,
    isWorktree: true,
    mainPath: "/repo",
  };

  const mockOpen = (byPath: Record<string, RepoSummary>) => {
    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "open_repo") {
        const { path } = args as { path: string };
        return Promise.resolve(byPath[path] ?? { ...mainSummary, path, workdir: path });
      }
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      return defaultInvoke(cmd);
    });
  };

  beforeEach(() => {
    localStorage.clear();
    useRepo.setState({
      summary: mainSummary,
      openPaths: ["/repo", "/other"],
      tabInfoByPath: {
        "/repo": { isWorktree: false, mainPath: null, branch: "main" },
        "/other": { isWorktree: false, mainPath: null, branch: "main" },
      },
    });
  });

  it("switches the current tab in place by default (one repo, one tab)", async () => {
    mockOpen({ [wtSummary.path]: wtSummary });

    await useRepo.getState().openWorktree(wtSummary.path);

    // The worktree replaced the main checkout's tab — no sibling tab appeared.
    expect(useRepo.getState().openPaths).toEqual([wtSummary.path, "/other"]);
    expect(useRepo.getState().summary?.path).toBe(wtSummary.path);
    // The strip knows it's a worktree of /repo on d/lewin (label + grouping).
    expect(useRepo.getState().tabInfoByPath[wtSummary.path]).toEqual({
      isWorktree: true,
      mainPath: "/repo",
      branch: "d/lewin",
    });
    // The replaced tab's info no longer lingers.
    expect(useRepo.getState().tabInfoByPath["/repo"]).toBeUndefined();
    expect(JSON.parse(localStorage.getItem("gitlane.openPaths:v1") ?? "[]")).toEqual([
      wtSummary.path,
      "/other",
    ]);
  });

  it("opens a separate tab grouped next to the repository on newTab", async () => {
    mockOpen({ [wtSummary.path]: wtSummary });

    await useRepo.getState().openWorktree(wtSummary.path, { newTab: true });

    // Inserted right after /repo (its parent), not appended after /other.
    expect(useRepo.getState().openPaths).toEqual(["/repo", wtSummary.path, "/other"]);
    expect(useRepo.getState().summary?.path).toBe(wtSummary.path);
  });

  it("just activates a worktree that is already open in another tab", async () => {
    useRepo.setState({ openPaths: ["/repo", wtSummary.path] });
    mockOpen({ [wtSummary.path]: wtSummary });

    await useRepo.getState().openWorktree(wtSummary.path);

    // No duplicate tab, no replacement — the existing tab became active.
    expect(useRepo.getState().openPaths).toEqual(["/repo", wtSummary.path]);
    expect(useRepo.getState().summary?.path).toBe(wtSummary.path);
  });
});

describe("repo store — refreshTabInfo (GL-116 background-tab labels)", () => {
  beforeEach(() => {
    localStorage.clear();
    useRepo.setState({
      openPaths: ["/a", "/b"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/b": { isWorktree: false, mainPath: null, branch: "old" },
      },
    });
  });

  it("re-probes one tab's identity without loading the repo", async () => {
    invokeMock.mockImplementation((cmd: string, args?: { paths?: string[] }) => {
      if (cmd === "recents_status") {
        expect(args?.paths).toEqual(["/b"]);
        return Promise.resolve([
          { path: "/b", exists: true, branch: "new", isWorktree: true, mainPath: "/a" },
        ]);
      }
      return defaultInvoke(cmd);
    });

    await useRepo.getState().refreshTabInfo("/b");

    // The label follows the fresh probe; the repo was never opened.
    expect(useRepo.getState().tabInfoByPath["/b"]).toEqual({
      isWorktree: true,
      mainPath: "/a",
      branch: "new",
    });
    expect(useRepo.getState().tabInfoByPath["/a"].branch).toBe("main");
    expect(invokeMock).not.toHaveBeenCalledWith("open_repo", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("commit_graph", expect.anything());
  });

  it("keeps the last-known label when the tab probes gone", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "recents_status"
        ? Promise.resolve([
            { path: "/b", exists: false, branch: null, isWorktree: false, mainPath: null },
          ])
        : defaultInvoke(cmd),
    );

    await useRepo.getState().refreshTabInfo("/b");

    expect(useRepo.getState().tabInfoByPath["/b"].branch).toBe("old");
  });

  it("drops the update if the tab closed while probing", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "recents_status"
        ? Promise.resolve([
            { path: "/b", exists: true, branch: "new", isWorktree: false, mainPath: null },
          ])
        : defaultInvoke(cmd),
    );

    const probe = useRepo.getState().refreshTabInfo("/b");
    // The tab closes before the probe resolves.
    useRepo.setState({ openPaths: ["/a"] });
    await probe;

    expect(useRepo.getState().tabInfoByPath["/b"]?.branch).toBe("old");
  });
});
