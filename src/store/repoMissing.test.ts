// The dedicated missing-repo state (GL-108): opening a tab whose path no
// longer resolves swaps the workspace for a recovery screen (Remove / Locate… /
// Retry) instead of putting the raw libgit2 error on the global bar.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the IPC boundary and the folder picker (Locate…) so the store's async
// actions run headlessly (canonical vi.hoisted + vi.mock pattern).
const invokeMock = vi.hoisted(() => vi.fn());
const dialogMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogMock }));

import { useRepo } from "./repo";
import { useNotifications } from "./notifications";
import { createInitialRepoData, SESSION_RESTORE_PHASE } from "./repoTypes";
import type { RepoGraph, RepoOpenError, RepoSummary, WorkingChanges } from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";

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
const EMPTY_CHANGES: WorkingChanges = { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState };

// The classified `open_repo` rejection for a vanished path.
const missingError = (path: string): RepoOpenError => ({
  kind: "missing",
  message: `This repository can't be found at ${path}. It may have been moved or deleted.`,
  path,
});

const defaultInvoke = (cmd: string) =>
  Promise.resolve(cmd === "working_changes" ? EMPTY_CHANGES : []);

// Resolve a healthy repo at `path` for every read an open performs.
const healthyInvoke =
  (openSummary: RepoSummary) =>
  (cmd: string): Promise<unknown> => {
    switch (cmd) {
      case "open_repo":
        return Promise.resolve(openSummary);
      case "commit_graph":
        return Promise.resolve(emptyGraph);
      case "working_changes":
        return Promise.resolve(EMPTY_CHANGES);
      default:
        return defaultInvoke(cmd);
    }
  };

beforeEach(() => {
  invokeMock.mockReset();
  // Fire-and-forget IPC (e.g. unwatch on tab close) must resolve rather than
  // return `undefined`; tests that care set their own impl.
  invokeMock.mockResolvedValue(undefined);
  dialogMock.mockReset();
  localStorage.clear();
  useRepo.setState(createInitialRepoData([], []));
  useNotifications.getState().dismissAll();
});

describe("repo store — missing-repo state (GL-108)", () => {
  it("enters the missing state instead of the error bar when open_repo classifies a vanished path", async () => {
    useRepo.setState({
      openPaths: ["/gone"],
      recents: [{ path: "/gone", name: "gone", branch: "main", lastOpenedAt: 1 }],
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "open_repo" ? Promise.reject(missingError("/gone")) : defaultInvoke(cmd),
    );

    await useRepo.getState().loadRepo("/gone");

    const s = useRepo.getState();
    expect(s.missingRepo).toEqual({ path: "/gone", kind: "missing" });
    // Never the raw open error, and no repo data mixed under the state.
    expect(s.error).toBeNull();
    expect(s.summary).toBeNull();
    // The tab survives so Remove / Locate… / Retry can act on it, and the
    // recents entry is flagged without waiting for the next disk probe.
    expect(s.openPaths).toEqual(["/gone"]);
    expect(s.recents[0]?.missing).toBe(true);
  });

  it("clears the previously shown repo when a dead tab is clicked (no banner-over-content mix)", async () => {
    useRepo.setState({
      summary,
      graph: emptyGraph,
      openPaths: ["/repo", "/gone"],
    });
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) =>
      cmd === "open_repo" && args?.path === "/gone"
        ? Promise.reject(missingError("/gone"))
        : defaultInvoke(cmd),
    );

    await useRepo.getState().loadRepo("/gone");

    const s = useRepo.getState();
    expect(s.missingRepo?.path).toBe("/gone");
    expect(s.summary).toBeNull();
    expect(s.graph).toBeNull();
  });

  it("keeps the error-bar behavior for open failures that are not a vanished path", async () => {
    useRepo.setState({ summary, graph: emptyGraph, openPaths: ["/repo"] });
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) =>
      cmd === "open_repo" && args?.path === "/bad"
        ? Promise.reject(new Error("bad pick"))
        : defaultInvoke(cmd),
    );

    await useRepo.getState().loadRepo("/bad");

    const s = useRepo.getState();
    expect(s.missingRepo).toBeNull();
    expect(s.error).toContain("bad pick");
    // GL-20: the current repo stays untouched under the error bar.
    expect(s.summary).toBe(summary);
  });

  it("clears the missing state when a retry succeeds", async () => {
    useRepo.setState({
      missingRepo: { path: "/gone", kind: "missing" },
      openPaths: ["/gone"],
    });
    invokeMock.mockImplementation(healthyInvoke({ ...summary, path: "/gone", workdir: "/gone" }));

    await useRepo.getState().loadRepo("/gone");

    const s = useRepo.getState();
    expect(s.missingRepo).toBeNull();
    expect(s.summary?.path).toBe("/gone");
  });

  it("swaps to the missing state when the displayed repo vanishes on refresh", async () => {
    useRepo.setState({ summary, graph: emptyGraph, openPaths: ["/repo"] });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "open_repo" ? Promise.reject(missingError("/repo")) : defaultInvoke(cmd),
    );

    await useRepo.getState().refresh({ prs: false });

    const s = useRepo.getState();
    expect(s.missingRepo).toEqual({ path: "/repo", kind: "missing" });
    expect(s.error).toBeNull();
    expect(s.summary).toBeNull();
  });

  it("re-probes with the classified open when a non-open read fails, so a raw graph error can't reach the bar", async () => {
    // The initial open succeeds; the repo vanishes before the (slow) graph
    // read, so the probe re-open rejects with the classified error.
    let openCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          openCalls += 1;
          return openCalls === 1 ? Promise.resolve(summary) : Promise.reject(missingError("/repo"));
        case "commit_graph":
          return Promise.reject(new Error("failed to resolve path '/repo'"));
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().loadRepo("/repo");

    const s = useRepo.getState();
    expect(s.missingRepo).toEqual({ path: "/repo", kind: "missing" });
    expect(s.error).toBeNull();
  });

  it("keeps the exact kind through the probe: a folder that lost its .git reads notARepository", async () => {
    const notARepo: RepoOpenError = {
      kind: "notARepository",
      message: "The folder at /repo is not a git repository anymore.",
      path: "/repo",
    };
    let openCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          openCalls += 1;
          return openCalls === 1 ? Promise.resolve(summary) : Promise.reject(notARepo);
        case "commit_graph":
          return Promise.reject(new Error("could not read HEAD"));
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().loadRepo("/repo");

    expect(useRepo.getState().missingRepo).toEqual({ path: "/repo", kind: "notARepository" });
  });

  it("persists the missing tab as the active one so restore returns to it", async () => {
    localStorage.setItem("gitlane.lastPath", "/repo");
    useRepo.setState({ summary, graph: emptyGraph, openPaths: ["/repo", "/gone"] });
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) =>
      cmd === "open_repo" && args?.path === "/gone"
        ? Promise.reject(missingError("/gone"))
        : defaultInvoke(cmd),
    );

    await useRepo.getState().loadRepo("/gone");

    // What restores on relaunch matches what's on screen: the missing tab,
    // not the repo the user had switched away from.
    expect(localStorage.getItem("gitlane.lastPath")).toBe("/gone");
  });

  it("Remove (closeRepo on the missing tab) drops the tab and lands on the welcome screen", async () => {
    useRepo.setState({
      missingRepo: { path: "/gone", kind: "missing" },
      openPaths: ["/gone"],
    });

    await useRepo.getState().closeRepo("/gone");

    const s = useRepo.getState();
    expect(s.missingRepo).toBeNull();
    expect(s.openPaths).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalledWith("open_repo", expect.anything());
  });

  it("Remove with a neighbour switches to it", async () => {
    useRepo.setState({
      missingRepo: { path: "/gone", kind: "missing" },
      openPaths: ["/other", "/gone"],
    });
    invokeMock.mockImplementation(healthyInvoke({ ...summary, path: "/other", workdir: "/other" }));

    await useRepo.getState().closeRepo("/gone");

    const s = useRepo.getState();
    expect(s.missingRepo).toBeNull();
    expect(s.openPaths).toEqual(["/other"]);
    expect(s.summary?.path).toBe("/other");
  });

  it("Locate… replaces the stale tab in place, migrates bindings, and opens the picked repo", async () => {
    useRepo.setState({
      missingRepo: { path: "/old", kind: "missing" },
      openPaths: ["/a", "/old"],
      recents: [{ path: "/old", name: "old", branch: "main", lastOpenedAt: 1, missing: true }],
    });
    // Per-repo maps keyed by the stale path — Locate… must carry them over.
    localStorage.setItem(
      "gitlane.repoAccounts",
      JSON.stringify({ "/old": { version: 2, unbound: true } }),
    );
    localStorage.setItem("gitlane.repoCommitSource", JSON.stringify({ "/old": { kind: "manual", id: "profile-1" } }));
    dialogMock.mockResolvedValue("/new");
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "open_repo") {
        return args?.path === "/new" || args?.path === "/new/sub"
          ? Promise.resolve({ ...summary, path: "/new", workdir: "/new" })
          : Promise.reject(missingError(args?.path ?? ""));
      }
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      return defaultInvoke(cmd);
    });

    await useRepo.getState().locateMissingRepo();

    const s = useRepo.getState();
    expect(s.missingRepo).toBeNull();
    expect(s.summary?.path).toBe("/new");
    // The stale tab was replaced in place (position kept), not appended.
    expect(s.openPaths).toEqual(["/a", "/new"]);
    // The dead recents entry is gone; the open recorded the new location.
    expect(s.recents.map((r) => r.path)).toEqual(["/new"]);
    // Account + profile bindings moved to the new path.
    expect(JSON.parse(localStorage.getItem("gitlane.repoAccounts") ?? "{}")).toEqual({
      "/new": { version: 2, unbound: true },
    });
    expect(JSON.parse(localStorage.getItem("gitlane.repoCommitSource") ?? "{}")).toEqual({
      "/new": { kind: "manual", id: "profile-1" },
    });
  });

  it("Locate… keeps the missing state when the picked folder is not a repository", async () => {
    useRepo.setState({
      missingRepo: { path: "/old", kind: "missing" },
      openPaths: ["/old"],
    });
    dialogMock.mockResolvedValue("/not-a-repo");
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "open_repo"
        ? Promise.reject({
            kind: "notARepository",
            message: "The folder at /not-a-repo is not a git repository anymore.",
            path: "/not-a-repo",
          } satisfies RepoOpenError)
        : defaultInvoke(cmd),
    );

    await useRepo.getState().locateMissingRepo();

    const s = useRepo.getState();
    expect(s.missingRepo).toEqual({ path: "/old", kind: "missing" });
    expect(s.openPaths).toEqual(["/old"]);
  });

  it("Locate… with an explicit stale path (onboarding recents) migrates bindings without a missing state", async () => {
    useRepo.setState({
      openPaths: [],
      recents: [{ path: "/old", name: "old", branch: null, lastOpenedAt: 1, missing: true }],
    });
    localStorage.setItem(
      "gitlane.repoAccounts",
      JSON.stringify({ "/old": { version: 2, unbound: true } }),
    );
    dialogMock.mockResolvedValue("/new");
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve({ ...summary, path: "/new", workdir: "/new" });
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      return defaultInvoke(cmd);
    });

    await useRepo.getState().locateMissingRepo("/old");

    const s = useRepo.getState();
    expect(s.summary?.path).toBe("/new");
    // The dead recents entry is replaced by the opened repo's fresh one.
    expect(s.recents.map((r) => r.path)).toEqual(["/new"]);
    expect(JSON.parse(localStorage.getItem("gitlane.repoAccounts") ?? "{}")).toEqual({
      "/new": { version: 2, unbound: true },
    });
  });

  it("Initialize as git repo (GL-153) runs init in place and opens the repo", async () => {
    useRepo.setState({
      missingRepo: { path: "/still/here", kind: "notARepository" },
      openPaths: ["/still/here"],
      recents: [{ path: "/still/here", name: "here", branch: "main", lastOpenedAt: 1, missing: true }],
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "init_repo_in_place") return Promise.resolve("/still/here");
      return healthyInvoke({ ...summary, path: "/still/here", workdir: "/still/here" })(cmd);
    });

    await useRepo.getState().initMissingRepo();

    expect(invokeMock).toHaveBeenCalledWith("init_repo_in_place", { path: "/still/here" });
    const s = useRepo.getState();
    expect(s.missingRepo).toBeNull();
    expect(s.summary?.path).toBe("/still/here");
    // The recents entry flagged `missing` when the state was entered must
    // clear once the repo is genuinely open again.
    expect(s.recents.find((r) => r.path === "/still/here")?.missing).toBeFalsy();
  });

  it("Initialize as git repo doesn't reopen if the tab moved on while init was in flight", async () => {
    useRepo.setState({
      missingRepo: { path: "/still/here", kind: "notARepository" },
      openPaths: ["/still/here"],
    });
    let resolveInit!: (path: string) => void;
    const initPromise = new Promise<string>((resolve) => {
      resolveInit = resolve;
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "init_repo_in_place" ? initPromise : defaultInvoke(cmd),
    );

    const call = useRepo.getState().initMissingRepo();
    // Remove resolved the tab (e.g. the user clicked it) while the init
    // subprocess was still running.
    useRepo.setState({ missingRepo: null, openPaths: [] });
    resolveInit("/still/here");
    await call;

    // The stale init's success must not reopen a repo nobody is looking at.
    expect(invokeMock).not.toHaveBeenCalledWith("open_repo", { path: "/still/here" });
    expect(useRepo.getState().missingRepo).toBeNull();
    expect(useRepo.getState().summary).toBeNull();
  });

  it("Initialize as git repo toasts and keeps the missing state when init fails", async () => {
    useRepo.setState({
      missingRepo: { path: "/still/here", kind: "notARepository" },
      openPaths: ["/still/here"],
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "init_repo_in_place"
        ? Promise.reject(new Error("Couldn't create repository: permission denied"))
        : defaultInvoke(cmd),
    );

    await useRepo.getState().initMissingRepo();

    const s = useRepo.getState();
    expect(s.missingRepo).toEqual({ path: "/still/here", kind: "notARepository" });
    expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toContain("permission denied");
  });

  it("Initialize as git repo opens the repo when init reports it is already a repository", async () => {
    useRepo.setState({
      missingRepo: { path: "/still/here", kind: "notARepository" },
      openPaths: ["/still/here"],
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "init_repo_in_place") {
        return Promise.reject(
          new Error("/still/here is already a Git repository — try Retry to open it."),
        );
      }
      return healthyInvoke({ ...summary, path: "/still/here", workdir: "/still/here" })(cmd);
    });

    await useRepo.getState().initMissingRepo();

    expect(invokeMock).toHaveBeenCalledWith("open_repo", { path: "/still/here" });
    const s = useRepo.getState();
    expect(s.missingRepo).toBeNull();
    expect(s.summary?.path).toBe("/still/here");
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });

  it("Initialize as git repo ignores a second call while the first is in flight", async () => {
    useRepo.setState({
      missingRepo: { path: "/still/here", kind: "notARepository" },
      openPaths: ["/still/here"],
    });
    let resolveInit!: (path: string) => void;
    const initPromise = new Promise<string>((resolve) => {
      resolveInit = resolve;
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "init_repo_in_place" ? initPromise : defaultInvoke(cmd),
    );

    const first = useRepo.getState().initMissingRepo();
    expect(useRepo.getState().initMissingRepoRunning).toBe(true);
    await useRepo.getState().initMissingRepo();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    // Drop the missing state before the first init settles so this test only
    // covers the in-flight guard, not the post-init open path.
    useRepo.setState({ missingRepo: null });
    resolveInit("/still/here");
    await first;
    expect(useRepo.getState().initMissingRepoRunning).toBe(false);
  });

  it("Initialize as git repo is a no-op for the moved/deleted (missing) kind", async () => {
    useRepo.setState({
      missingRepo: { path: "/vol/gone", kind: "missing" },
      openPaths: ["/vol/gone"],
    });

    await useRepo.getState().initMissingRepo();

    expect(invokeMock).not.toHaveBeenCalledWith("init_repo_in_place", expect.anything());
    expect(useRepo.getState().missingRepo).toEqual({ path: "/vol/gone", kind: "missing" });
  });

  it("restores a session whose last repo is missing into the state, not the error bar", async () => {
    localStorage.setItem("gitlane.lastPath", "/gone");
    useRepo.setState({
      openPaths: ["/gone"],
      sessionRestorePhase: SESSION_RESTORE_PHASE.Pending,
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "open_repo" ? Promise.reject(missingError("/gone")) : defaultInvoke(cmd),
    );

    await useRepo.getState().restoreSession();

    const s = useRepo.getState();
    expect(s.missingRepo).toEqual({ path: "/gone", kind: "missing" });
    expect(s.error).toBeNull();
    // The dead path stays persisted so the next launch lands here again.
    expect(localStorage.getItem("gitlane.lastPath")).toBe("/gone");
  });
});
