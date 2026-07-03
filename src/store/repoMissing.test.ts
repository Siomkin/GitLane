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
import { createInitialRepoData } from "./repoTypes";
import type { RepoGraph, RepoOpenError, RepoSummary, WorkingChanges } from "../lib/api";

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
const EMPTY_CHANGES: WorkingChanges = { staged: [], unstaged: [], conflicted: [] };

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
  dialogMock.mockReset();
  localStorage.clear();
  useRepo.setState(createInitialRepoData([], []));
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

  it("probes presence when a non-open read fails, so a raw graph error can't reach the bar for a vanished repo", async () => {
    invokeMock.mockImplementation((cmd: string, args?: { paths?: string[] }) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.reject(new Error("failed to resolve path '/repo'"));
        case "recents_status":
          return Promise.resolve(
            (args?.paths ?? []).map((path: string) => ({ path, exists: false, branch: null })),
          );
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().loadRepo("/repo");

    const s = useRepo.getState();
    expect(s.missingRepo).toEqual({ path: "/repo", kind: "missing" });
    expect(s.error).toBeNull();
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
    localStorage.setItem("gitlane.repoProfile", JSON.stringify({ "/old": "profile-1" }));
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
    expect(JSON.parse(localStorage.getItem("gitlane.repoProfile") ?? "{}")).toEqual({
      "/new": "profile-1",
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

  it("restores a session whose last repo is missing into the state, not the error bar", async () => {
    localStorage.setItem("gitlane.lastPath", "/gone");
    useRepo.setState({ openPaths: ["/gone"] });
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
