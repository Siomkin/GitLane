// Closing a repo, opening a worktree, and healing a restored session.
//
// Split out of the former src/store/repo.test.ts, which reached 5 122 lines;
// shared data fixtures live in @/test/repoFixtures.

import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { initialSessionRestorePhase } from "@/store/repoTypes";
import { ForgeKind } from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the IPC boundary so the store's async actions run headlessly. `vi.mock`
// is hoisted above the import below; `vi.hoisted` makes `invokeMock` exist in time.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { SESSION_RESTORE_PHASE, useRepo } from "@/store/repo";
import { defaultInvoke, deferred, emptyGraph, node, summary } from "@/test/repoFixtures";
import type {
  RepoForge,
  RepoGraph,
  RecentStatus,
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

  it("releases the closed tab's filesystem watch (GL-116)", async () => {
    useRepo.setState({ openPaths: ["/repo", "/other"], summary });

    await useRepo.getState().closeRepo("/other");

    expect(invokeMock).toHaveBeenCalledWith("unwatch_repo", { path: "/other" });
  });

  it("preserves a live fetch owner when its last tab closes", async () => {
    useRepo.setState({ openPaths: ["/repo"], summary, fetchingPath: "/repo" });

    await useRepo.getState().closeRepo("/repo");

    expect(useRepo.getState().summary).toBeNull();
    expect(useRepo.getState().fetchingPath).toBe("/repo");
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
    commits: [node({ id: "tip" })],
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
            unstaged: [{ path: "a.ts", status: "M", add: 1, del: 0, binary: false }],
            conflicted: [],
          });
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    // Opening a dirty worktree lands on its working tree, not the tip commit.
    expect(useRepo.getState().wipSelected).toBe(true);
    expect(useRepo.getState().selectedCommit).toBeNull();
  });

  it("keeps loadRepo's tip selection when the clean worktree's HEAD is unknown", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(wtSummary);
        case "commit_graph":
          return Promise.resolve(graphWithTip);
        case "working_changes":
          return Promise.resolve({ staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState });
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    expect(useRepo.getState().wipSelected).toBe(false);
    expect(useRepo.getState().selectedCommit).toBe("tip");
    expect(useRepo.getState().revealTarget).toBeNull();
  });

  it("reveals the worktree's HEAD row when the opened worktree is clean", async () => {
    // A detached worktree parked below the newest row: loadRepo's default
    // selection is commits[0] ("tip"), so without the reveal the switch lands
    // on the wrong commit with no scroll to where the worktree actually sits.
    const detachedSummary: RepoSummary = {
      ...wtSummary,
      headBranch: null,
      headOid: "old",
      detached: true,
    };
    const graphWithOld: RepoGraph = {
      ...emptyGraph,
      head: "old",
      commits: [node({ id: "tip" }), node({ id: "old" })],
    };
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(detachedSummary);
        case "commit_graph":
          return Promise.resolve(graphWithOld);
        case "working_changes":
          return Promise.resolve({ staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState });
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    expect(useRepo.getState().wipSelected).toBe(false);
    expect(useRepo.getState().selectedCommit).toBe("old");
    expect(useRepo.getState().revealTarget).toBe("old");
  });

  it("does not reveal HEAD when the opened worktree is dirty (WIP wins)", async () => {
    const detachedSummary: RepoSummary = {
      ...wtSummary,
      headBranch: null,
      headOid: "old",
      detached: true,
    };
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(detachedSummary);
        case "commit_graph":
          return Promise.resolve(graphWithTip);
        case "working_changes":
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "a.ts", status: "M", add: 1, del: 0, binary: false }],
            conflicted: [],
          });
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    // The WIP row is always the top row, so it needs no scroll; revealing HEAD
    // would yank the view away from the working tree that was just surfaced.
    expect(useRepo.getState().wipSelected).toBe(true);
    expect(useRepo.getState().revealTarget).toBeNull();
  });

  it("skips the reveal when the status read fails (dirty state unknown)", async () => {
    const detachedSummary: RepoSummary = {
      ...wtSummary,
      headBranch: null,
      headOid: "old",
      detached: true,
    };
    const graphWithOld: RepoGraph = {
      ...emptyGraph,
      head: "old",
      commits: [node({ id: "tip" }), node({ id: "old" })],
    };
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(detachedSummary);
        case "commit_graph":
          return Promise.resolve(graphWithOld);
        case "working_changes":
          return Promise.reject(new Error("status failed"));
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    // The worktree may be dirty for all we know — revealing HEAD could yank it
    // away from its working tree. Keep loadRepo's default (newest row).
    expect(useRepo.getState().selectedCommit).toBe("tip");
    expect(useRepo.getState().revealTarget).toBeNull();
  });

  it("does not clobber a branch picked while the graph was loading (GL-20)", async () => {
    const detachedSummary: RepoSummary = {
      ...wtSummary,
      headBranch: null,
      headOid: "tip",
      detached: true,
    };
    const graphWithOld: RepoGraph = {
      ...emptyGraph,
      head: "tip",
      commits: [node({ id: "tip" }), node({ id: "old" })],
    };
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(detachedSummary);
        case "commit_graph": {
          // Emulate the user picking a branch in the navigator while the graph
          // skeleton is up: the pick lands after Phase 2 cleared the selection
          // and before the graph resolves, so loadRepo honors it.
          useRepo.setState({
            revealTarget: "old",
            selectedCommit: "old",
            selectedCommits: ["old"],
            selectionAnchor: "old",
          });
          return Promise.resolve(graphWithOld);
        }
        case "working_changes":
          return Promise.resolve({ staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState });
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    // The during-load pick survives; the HEAD reveal must not overwrite it.
    expect(useRepo.getState().revealTarget).toBe("old");
    expect(useRepo.getState().selectedCommit).toBe("old");
  });

  it("does not clobber a selection made while the status read is in flight", async () => {
    const detachedSummary: RepoSummary = {
      ...wtSummary,
      headBranch: null,
      headOid: "old",
      detached: true,
    };
    const graphThreeDeep: RepoGraph = {
      ...emptyGraph,
      head: "old",
      commits: [node({ id: "tip" }), node({ id: "mid" }), node({ id: "old" })],
    };
    // Call #1 is loadRepo's fire-and-forget status fan-out; call #2 is
    // openWorktree's own await'd read. The selection flips during #2 —
    // after openWorktree snapshotted the parked selection, before its await
    // resumes — emulating a graph click while the status read is in flight.
    let statusCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(detachedSummary);
        case "commit_graph":
          return Promise.resolve(graphThreeDeep);
        case "working_changes":
          statusCalls += 1;
          if (statusCalls === 2) {
            useRepo.setState({ selectedCommit: "mid", selectedCommits: ["mid"], selectionAnchor: "mid" });
          }
          return Promise.resolve({ staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState });
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    // The user's click wins over the automatic HEAD reveal.
    expect(useRepo.getState().selectedCommit).toBe("mid");
    expect(useRepo.getState().revealTarget).toBeNull();
  });

  it("does not yank an in-flight selection to WIP when the worktree is dirty", async () => {
    const detachedSummary: RepoSummary = {
      ...wtSummary,
      headBranch: null,
      headOid: "old",
      detached: true,
    };
    const graphThreeDeep: RepoGraph = {
      ...emptyGraph,
      head: "old",
      commits: [node({ id: "tip" }), node({ id: "mid" }), node({ id: "old" })],
    };
    // Same shape as the clean-path race above, but the status read comes back
    // dirty: the user's click during the await must win over the automatic
    // selectWip() too — deliberate navigation beats the WIP auto-landing.
    let statusCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(detachedSummary);
        case "commit_graph":
          return Promise.resolve(graphThreeDeep);
        case "working_changes":
          statusCalls += 1;
          if (statusCalls === 2) {
            useRepo.setState({ selectedCommit: "mid", selectedCommits: ["mid"], selectionAnchor: "mid" });
          }
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "a.ts", status: "M", add: 1, del: 0, binary: false }],
            conflicted: [],
          });
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    expect(useRepo.getState().selectedCommit).toBe("mid");
    expect(useRepo.getState().wipSelected).toBe(false);
  });

  it("skips the reveal when loadRepo already parked on the HEAD row", async () => {
    // A tip-aligned worktree: loadRepo's default selection is the newest row,
    // which IS the worktree's HEAD — re-revealing would only re-fetch files
    // and flash the row the user is already looking at.
    const tipSummary: RepoSummary = { ...wtSummary, headOid: "tip" };
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(tipSummary);
        case "commit_graph":
          return Promise.resolve(graphWithTip);
        case "working_changes":
          return Promise.resolve({ staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState });
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    expect(useRepo.getState().selectedCommit).toBe("tip");
    expect(useRepo.getState().revealTarget).toBeNull();
  });

  it("does nothing after a failed load (the previous repo stays untouched)", async () => {
    useRepo.setState({
      summary: {
        path: "/repo-main",
        workdir: "/repo-main",
        headBranch: "main",
        headOid: "tip",
        detached: false,
      },
      selectedCommit: "tip",
      revealTarget: null,
    });
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.reject(new Error("cannot open"));
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    // loadRepo absorbed the failure and left the previous repo active — the
    // post-load status read and reveal must not run against it.
    expect(invokeMock.mock.calls.map((c) => c[0])).not.toContain("working_changes");
    expect(useRepo.getState().selectedCommit).toBe("tip");
    expect(useRepo.getState().revealTarget).toBeNull();
  });
});

describe("repo store — restoreSession heals dead tabs (GL-109)", () => {
  const aliveSummary: RepoSummary = {
    path: "/a",
    workdir: "/a",
    headBranch: "main",
    headOid: null,
    detached: false,
    isWorktree: false,
    mainPath: null,
  };

  beforeEach(() => {
    localStorage.clear();
    useRepo.setState({
      summary: null,
      openPaths: ["/a", "/dead-wt"],
      sessionRestorePhase: SESSION_RESTORE_PHASE.Pending,
      // The persisted tab info is what lets restore recognize the dead path as
      // a *worktree* (the gone directory can't answer anymore).
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/dead-wt": { isWorktree: true, mainPath: "/a", branch: "d/lewin" },
      },
    });
  });

  it("marks open tabs for restoration even when the last-active path is missing", () => {
    expect(initialSessionRestorePhase(["/a"], null)).toBe(SESSION_RESTORE_PHASE.Pending);
    expect(initialSessionRestorePhase([], null)).toBe(SESSION_RESTORE_PHASE.Complete);
  });

  it("still probes and heals open tabs when the last-active path is missing", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "recents_status") {
        return Promise.resolve([
          { path: "/a", exists: true, branch: "main", isWorktree: false, mainPath: null },
          { path: "/dead-wt", exists: false, branch: null, isWorktree: false, mainPath: null },
        ]);
      }
      return defaultInvoke(cmd);
    });

    await useRepo.getState().restoreSession();

    expect(invokeMock).toHaveBeenCalledWith("recents_status", {
      paths: ["/a", "/dead-wt"],
    });
    expect(invokeMock).not.toHaveBeenCalledWith("open_repo", expect.anything());
    expect(useRepo.getState().openPaths).toEqual(["/a"]);
    expect(useRepo.getState().sessionRestorePhase).toBe(SESSION_RESTORE_PHASE.Complete);
  });

  it("drops a removed worktree tab and heals the last-active path to a survivor", async () => {
    localStorage.setItem("gitlane.lastPath", "/dead-wt");
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "recents_status":
          return Promise.resolve([
            { path: "/a", exists: true, branch: "main", isWorktree: false, mainPath: null },
            // A pruned agent worktree: gone from disk since last session.
            { path: "/dead-wt", exists: false, branch: null, isWorktree: false, mainPath: null },
          ]);
        case "open_repo":
          return Promise.resolve(aliveSummary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().restoreSession();

    // The dead tab is gone instead of restoring as an error tab, and the app
    // reopened on the surviving repo.
    expect(useRepo.getState().openPaths).toEqual(["/a"]);
    expect(useRepo.getState().summary?.path).toBe("/a");
    expect(useRepo.getState().sessionRestorePhase).toBe(SESSION_RESTORE_PHASE.Complete);
    expect(JSON.parse(localStorage.getItem("gitlane.openPaths:v1") ?? "[]")).toEqual(["/a"]);
    expect(localStorage.getItem("gitlane.lastPath")).toBe("/a");
  });

  it("keeps a missing *repository* tab for the GL-108 recovery screen", async () => {
    // A dead path that was NOT a worktree (a repo on an unmounted volume):
    // the tab must survive so Retry/Locate stay reachable.
    useRepo.setState({
      openPaths: ["/a", "/gone-repo"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/gone-repo": { isWorktree: false, mainPath: null, branch: "main" },
      },
    });
    localStorage.setItem("gitlane.lastPath", "/a");
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "recents_status":
          return Promise.resolve([
            { path: "/a", exists: true, branch: "main", isWorktree: false, mainPath: null },
            { path: "/gone-repo", exists: false, branch: null, isWorktree: false, mainPath: null },
          ]);
        case "open_repo":
          return Promise.resolve(aliveSummary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().restoreSession();

    expect(useRepo.getState().openPaths).toEqual(["/a", "/gone-repo"]);
    expect(useRepo.getState().summary?.path).toBe("/a");
  });

  it("keeps restored tabs when the probe itself fails", async () => {
    localStorage.setItem("gitlane.lastPath", "/a");
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "recents_status":
          return Promise.reject(new Error("probe failed"));
        case "open_repo":
          return Promise.resolve(aliveSummary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().restoreSession();

    expect(useRepo.getState().openPaths).toEqual(["/a", "/dead-wt"]);
    expect(useRepo.getState().summary?.path).toBe("/a");
  });

  it("watches every live background tab so it doesn't go stale (GL-116)", async () => {
    // Two live repos: /a is the last-active (watched by loadRepo), /b is a
    // background tab that no loadRepo ever runs for until activated — it must
    // still get its own watch on restore.
    useRepo.setState({
      openPaths: ["/a", "/b"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/b": { isWorktree: false, mainPath: null, branch: "dev" },
      },
    });
    localStorage.setItem("gitlane.lastPath", "/a");
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "recents_status":
          return Promise.resolve([
            { path: "/a", exists: true, branch: "main", isWorktree: false, mainPath: null },
            { path: "/b", exists: true, branch: "dev", isWorktree: false, mainPath: null },
          ]);
        case "open_repo":
          return Promise.resolve(aliveSummary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().restoreSession();

    // The background tab is watched by path; the active one is watched by
    // loadRepo (also by path) rather than left to this fallback.
    expect(invokeMock).toHaveBeenCalledWith("watch_repo", { path: "/b" });
    expect(invokeMock).toHaveBeenCalledWith("watch_repo", { path: "/a" });
  });

  it("never watches a dead background tab (GL-116)", async () => {
    localStorage.setItem("gitlane.lastPath", "/a");
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "recents_status":
          return Promise.resolve([
            { path: "/a", exists: true, branch: "main", isWorktree: false, mainPath: null },
            { path: "/dead-wt", exists: false, branch: null, isWorktree: false, mainPath: null },
          ]);
        case "open_repo":
          return Promise.resolve(aliveSummary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().restoreSession();

    expect(invokeMock).not.toHaveBeenCalledWith("watch_repo", { path: "/dead-wt" });
  });

  it("preserves a background-tab close while the startup probe is pending", async () => {
    const statusProbe = deferred<RecentStatus[]>();
    useRepo.setState({
      openPaths: ["/a", "/b"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/b": { isWorktree: false, mainPath: null, branch: "dev" },
      },
    });
    localStorage.setItem("gitlane.lastPath", "/a");
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "recents_status":
          return statusProbe.promise;
        case "open_repo":
          return Promise.resolve(aliveSummary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        default:
          return defaultInvoke(cmd);
      }
    });

    const restoring = useRepo.getState().restoreSession();
    await useRepo.getState().closeRepo("/b");
    statusProbe.resolve([
      { path: "/a", exists: true, branch: "main", isWorktree: false, mainPath: null },
      { path: "/b", exists: true, branch: "dev", isWorktree: false, mainPath: null },
    ]);
    await restoring;
    await Promise.resolve();

    expect(useRepo.getState().openPaths).toEqual(["/a"]);
    expect(useRepo.getState().summary?.path).toBe("/a");
    expect(
      invokeMock.mock.calls.filter(
        ([cmd, args]) => cmd === "open_repo" && (args as { path?: string })?.path === "/a",
      ),
    ).toHaveLength(1);
    expect(invokeMock).not.toHaveBeenCalledWith("watch_repo", { path: "/b" });
    expect(
      invokeMock.mock.calls.filter(
        ([cmd, args]) => cmd === "unwatch_repo" && (args as { path?: string })?.path === "/b",
      ),
    ).toHaveLength(1);
  });

  it("does not reopen the persisted tab over a newer pending user open", async () => {
    const statusProbe = deferred<RecentStatus[]>();
    const openedC = deferred<RepoSummary>();
    useRepo.setState({
      openPaths: ["/a", "/b"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/b": { isWorktree: false, mainPath: null, branch: "dev" },
      },
    });
    localStorage.setItem("gitlane.lastPath", "/a");
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "recents_status") return statusProbe.promise;
      if (cmd === "open_repo" && args?.path === "/c") return openedC.promise;
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      return defaultInvoke(cmd);
    });

    const restoring = useRepo.getState().restoreSession();
    const openingC = useRepo.getState().loadRepo("/c");
    statusProbe.resolve([
      { path: "/a", exists: true, branch: "main", isWorktree: false, mainPath: null },
      { path: "/b", exists: true, branch: "dev", isWorktree: false, mainPath: null },
    ]);
    await restoring;

    expect(useRepo.getState().openPaths).toEqual(["/a", "/b"]);
    expect(useRepo.getState().summary).toBeNull();
    expect(useRepo.getState().sessionRestorePhase).toBe(SESSION_RESTORE_PHASE.Complete);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "open_repo")).toEqual([
      ["open_repo", { path: "/c" }],
    ]);

    openedC.resolve({
      ...aliveSummary,
      path: "/c",
      workdir: "/c",
      headBranch: "fresh",
    });
    await openingC;

    expect(useRepo.getState().summary?.path).toBe("/c");
    expect(useRepo.getState().openPaths).toEqual(["/a", "/b", "/c"]);
    expect(localStorage.getItem("gitlane.lastPath")).toBe("/c");
  });

  it("does not prune an existing worktree while its newer activation is pending", async () => {
    const statusProbe = deferred<RecentStatus[]>();
    const openedB = deferred<RepoSummary>();
    useRepo.setState({
      openPaths: ["/a", "/b"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/b": { isWorktree: true, mainPath: "/a", branch: "topic" },
      },
    });
    localStorage.setItem("gitlane.lastPath", "/a");
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "recents_status") return statusProbe.promise;
      if (cmd === "open_repo" && args?.path === "/b") return openedB.promise;
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      return defaultInvoke(cmd);
    });

    const restoring = useRepo.getState().restoreSession();
    const activatingB = useRepo.getState().loadRepo("/b");
    statusProbe.resolve([
      { path: "/a", exists: true, branch: "main", isWorktree: false, mainPath: null },
      { path: "/b", exists: false, branch: null, isWorktree: false, mainPath: null },
    ]);
    await restoring;
    await Promise.resolve();

    // The startup result is stale relative to the user's phase-1 activation.
    // Its unchanged lifetime/info cannot distinguish that target, so the newer
    // global open intent makes restore's destructive pruning stand down.
    expect(useRepo.getState().openPaths).toEqual(["/a", "/b"]);
    expect(
      invokeMock.mock.calls.filter(
        ([cmd, args]) => cmd === "unwatch_repo" && (args as { path?: string })?.path === "/b",
      ),
    ).toHaveLength(0);

    openedB.resolve({
      ...aliveSummary,
      path: "/b",
      workdir: "/b",
      headBranch: "fresh",
      isWorktree: true,
      mainPath: "/a",
    });
    await activatingB;

    expect(useRepo.getState().summary?.path).toBe("/b");
    expect(useRepo.getState().openPaths).toEqual(["/a", "/b"]);
    expect(useRepo.getState().tabInfoByPath["/b"]?.branch).toBe("fresh");
  });

  it("keeps newer metadata published within the same tab lifetime", async () => {
    const statusProbe = deferred<RecentStatus[]>();
    useRepo.setState({
      openPaths: ["/a", "/b"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/b": { isWorktree: true, mainPath: "/a", branch: "old" },
      },
    });
    localStorage.setItem("gitlane.lastPath", "/a");
    invokeMock.mockImplementation(
      (cmd: string, args?: { path?: string; paths?: string[] }) => {
        if (cmd === "recents_status" && args?.paths?.length === 2) {
          return statusProbe.promise;
        }
        if (cmd === "recents_status" && args?.paths?.[0] === "/b") {
          return Promise.resolve([
            {
              path: "/b",
              exists: true,
              branch: "fresh",
              isWorktree: true,
              mainPath: "/a",
            },
          ]);
        }
        if (cmd === "open_repo") return Promise.resolve(aliveSummary);
        if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
        return defaultInvoke(cmd);
      },
    );

    const restoring = useRepo.getState().restoreSession();
    // refreshTabInfo replaces the metadata object without closing the tab, so
    // its lifetime deliberately stays the same as restore's captured lease.
    await useRepo.getState().refreshTabInfo("/b");
    expect(useRepo.getState().tabInfoByPath["/b"]?.branch).toBe("fresh");

    statusProbe.resolve([
      { path: "/a", exists: true, branch: "main", isWorktree: false, mainPath: null },
      { path: "/b", exists: false, branch: null, isWorktree: false, mainPath: null },
    ]);
    await restoring;
    await Promise.resolve();

    expect(useRepo.getState().openPaths).toEqual(["/a", "/b"]);
    expect(useRepo.getState().tabInfoByPath["/b"]).toEqual({
      isWorktree: true,
      mainPath: "/a",
      branch: "fresh",
    });
    expect(
      invokeMock.mock.calls.filter(
        ([cmd, args]) => cmd === "unwatch_repo" && (args as { path?: string })?.path === "/b",
      ),
    ).toHaveLength(0);
  });

  it("preserves a live reorder and completed user open during the startup probe", async () => {
    const statusProbe = deferred<RecentStatus[]>();
    useRepo.setState({
      openPaths: ["/a", "/b"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/b": { isWorktree: false, mainPath: null, branch: "dev" },
      },
    });
    localStorage.setItem("gitlane.lastPath", "/a");
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "recents_status") return statusProbe.promise;
      if (cmd === "open_repo" && args?.path === "/c") {
        return Promise.resolve({
          ...aliveSummary,
          path: "/c",
          workdir: "/c",
          headBranch: "fresh",
        });
      }
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      return defaultInvoke(cmd);
    });

    const restoring = useRepo.getState().restoreSession();
    useRepo.getState().reorderOpenPaths(1, 0);
    await useRepo.getState().loadRepo("/c");
    expect(useRepo.getState().openPaths).toEqual(["/b", "/a", "/c"]);

    statusProbe.resolve([
      { path: "/a", exists: true, branch: "main", isWorktree: false, mainPath: null },
      { path: "/b", exists: true, branch: "dev", isWorktree: false, mainPath: null },
    ]);
    await restoring;

    expect(useRepo.getState().openPaths).toEqual(["/b", "/a", "/c"]);
    expect(useRepo.getState().summary?.path).toBe("/c");
    expect(useRepo.getState().tabInfoByPath["/c"]?.branch).toBe("fresh");
    expect(JSON.parse(localStorage.getItem("gitlane.openPaths:v1") ?? "[]")).toEqual([
      "/b",
      "/a",
      "/c",
    ]);
    expect(localStorage.getItem("gitlane.lastPath")).toBe("/c");
    expect(
      invokeMock.mock.calls.filter(
        ([cmd, args]) => cmd === "open_repo" && (args as { path?: string })?.path === "/a",
      ),
    ).toHaveLength(0);
  });

  it("ignores a stale missing result after the same path closes and reopens", async () => {
    const statusProbe = deferred<RecentStatus[]>();
    useRepo.setState({
      openPaths: ["/a", "/b"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/b": { isWorktree: true, mainPath: "/a", branch: "stale" },
      },
    });
    localStorage.setItem("gitlane.lastPath", "/a");
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "recents_status") return statusProbe.promise;
      if (cmd === "open_repo" && args?.path === "/b") {
        return Promise.resolve({
          ...aliveSummary,
          path: "/b",
          workdir: "/b",
          headBranch: "fresh",
          isWorktree: true,
          mainPath: "/a",
        });
      }
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      return defaultInvoke(cmd);
    });

    const restoring = useRepo.getState().restoreSession();
    await useRepo.getState().closeRepo("/b");
    await useRepo.getState().loadRepo("/b");
    statusProbe.resolve([
      { path: "/a", exists: true, branch: "main", isWorktree: false, mainPath: null },
      { path: "/b", exists: false, branch: null, isWorktree: false, mainPath: null },
    ]);
    await restoring;
    await Promise.resolve();

    expect(useRepo.getState().openPaths).toEqual(["/a", "/b"]);
    expect(useRepo.getState().summary?.path).toBe("/b");
    expect(useRepo.getState().tabInfoByPath["/b"]).toEqual({
      isWorktree: true,
      mainPath: "/a",
      branch: "fresh",
    });
    expect(localStorage.getItem("gitlane.lastPath")).toBe("/b");
    expect(
      invokeMock.mock.calls.filter(
        ([cmd, args]) => cmd === "unwatch_repo" && (args as { path?: string })?.path === "/b",
      ),
    ).toHaveLength(1);
  });

  it("reconciles an unchanged restore once: prune dead, watch background, open last", async () => {
    useRepo.setState({
      openPaths: ["/a", "/dead-wt", "/b"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "old-main" },
        "/dead-wt": { isWorktree: true, mainPath: "/a", branch: "gone" },
        "/b": { isWorktree: false, mainPath: null, branch: "old-dev" },
      },
    });
    localStorage.setItem("gitlane.lastPath", "/a");
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "recents_status":
          return Promise.resolve([
            { path: "/a", exists: true, branch: "main", isWorktree: false, mainPath: null },
            { path: "/dead-wt", exists: false, branch: null, isWorktree: false, mainPath: null },
            { path: "/b", exists: true, branch: "dev", isWorktree: false, mainPath: null },
          ]);
        case "open_repo":
          return Promise.resolve(aliveSummary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        default:
          return defaultInvoke(cmd);
      }
    });

    const restoring = useRepo.getState().restoreSession();
    const duplicate = useRepo.getState().restoreSession();
    await Promise.all([restoring, duplicate]);
    await Promise.resolve();

    expect(useRepo.getState().openPaths).toEqual(["/a", "/b"]);
    expect(useRepo.getState().summary?.path).toBe("/a");
    expect(useRepo.getState().tabInfoByPath["/b"]?.branch).toBe("dev");
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "recents_status")).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "open_repo")).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("watch_repo", { path: "/b" });
    expect(invokeMock).toHaveBeenCalledWith("watch_repo", { path: "/a" });
    expect(invokeMock).toHaveBeenCalledWith("unwatch_repo", { path: "/dead-wt" });
  });

  it("heals a pruned last tab to the first survivor in the live reordered strip", async () => {
    const statusProbe = deferred<RecentStatus[]>();
    useRepo.setState({
      openPaths: ["/a", "/dead-wt", "/b"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/dead-wt": { isWorktree: true, mainPath: "/a", branch: "gone" },
        "/b": { isWorktree: false, mainPath: null, branch: "dev" },
      },
    });
    localStorage.setItem("gitlane.lastPath", "/dead-wt");
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "recents_status") return statusProbe.promise;
      if (cmd === "open_repo" && args?.path) {
        return Promise.resolve({
          ...aliveSummary,
          path: args.path,
          workdir: args.path,
          headBranch: args.path === "/b" ? "dev" : "main",
        });
      }
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      return defaultInvoke(cmd);
    });

    const restoring = useRepo.getState().restoreSession();
    useRepo.getState().reorderOpenPaths(2, 0);
    statusProbe.resolve([
      { path: "/a", exists: true, branch: "main", isWorktree: false, mainPath: null },
      { path: "/dead-wt", exists: false, branch: null, isWorktree: false, mainPath: null },
      { path: "/b", exists: true, branch: "dev", isWorktree: false, mainPath: null },
    ]);
    await restoring;

    expect(useRepo.getState().openPaths).toEqual(["/b", "/a"]);
    expect(useRepo.getState().summary?.path).toBe("/b");
    expect(localStorage.getItem("gitlane.lastPath")).toBe("/b");
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "open_repo")).toEqual([
      ["open_repo", { path: "/b" }],
    ]);
  });

  it("restores a lastPath-only partial session as a new tab", async () => {
    useRepo.setState({
      openPaths: [],
      tabInfoByPath: {},
      sessionRestorePhase: SESSION_RESTORE_PHASE.Pending,
    });
    localStorage.setItem("gitlane.lastPath", "/a");
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(aliveSummary);
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      return defaultInvoke(cmd);
    });

    await useRepo.getState().restoreSession();

    expect(useRepo.getState().openPaths).toEqual(["/a"]);
    expect(useRepo.getState().summary?.path).toBe("/a");
    expect(localStorage.getItem("gitlane.lastPath")).toBe("/a");
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "open_repo")).toHaveLength(1);
    expect(invokeMock).not.toHaveBeenCalledWith("recents_status", expect.anything());
    expect(useRepo.getState().sessionRestorePhase).toBe(SESSION_RESTORE_PHASE.Complete);
  });

  it("claims startup restoration once while it is in flight", async () => {
    localStorage.setItem("gitlane.lastPath", "/a");
    const statusProbe = deferred<
      Array<{ path: string; exists: boolean; branch: string; isWorktree: boolean; mainPath: null }>
    >();
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "recents_status":
          return statusProbe.promise;
        case "open_repo":
          return Promise.resolve(aliveSummary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        default:
          return defaultInvoke(cmd);
      }
    });

    const firstRestore = useRepo.getState().restoreSession();
    const duplicateRestore = useRepo.getState().restoreSession();

    expect(useRepo.getState().sessionRestorePhase).toBe(SESSION_RESTORE_PHASE.Restoring);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "recents_status")).toHaveLength(1);

    statusProbe.resolve([
      { path: "/a", exists: true, branch: "main", isWorktree: false, mainPath: null },
      { path: "/dead-wt", exists: false, branch: "", isWorktree: false, mainPath: null },
    ]);
    await Promise.all([firstRestore, duplicateRestore]);

    expect(useRepo.getState().summary?.path).toBe("/a");
    expect(useRepo.getState().sessionRestorePhase).toBe(SESSION_RESTORE_PHASE.Complete);
  });
});
