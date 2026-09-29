// Every path that drops a repo tab from the strip must close that tab's
// terminals: the panes manager disposes a PTY only when its tab leaves
// `useTerminals.byRepo`, so a skipped drop leaves a shell running with no UI.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
const dialogMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogMock }));

import { emptyAdvancedState } from "@/lib/advancedRepoState";
import type { CommandErrorPayload, RecentStatus, RepoGraph, RepoSummary } from "@/lib/api";
import type { TabInfo } from "@/lib/tabs";
import { useRepo } from "@/store/repo";
import { createInitialRepoData } from "@/store/repoTypes";
import { useTerminals } from "@/store/terminals";

const summaryAt = (path: string, extra: Partial<RepoSummary> = {}): RepoSummary => ({
  path,
  workdir: path,
  headBranch: "main",
  headOid: null,
  detached: false,
  unborn: false,
  isWorktree: false,
  ...extra,
});
const emptyGraph: RepoGraph = {
  commits: [],
  edges: [],
  laneCount: 1,
  wipLane: null,
  head: null,
  truncated: false,
};
const worktreeInfo = (mainPath: string): TabInfo => ({ isWorktree: true, mainPath, branch: "feat" });
const missingError = (path: string): CommandErrorPayload => ({
  kind: "missingPath",
  message: `This repository can't be found at ${path}.`,
  path,
});

const invokeWithDead =
  (dead: string[], statuses: RecentStatus[] = []) =>
  (cmd: string, args?: { path?: string; paths?: string[] }): Promise<unknown> => {
    switch (cmd) {
      case "open_repo": {
        const p = args?.path ?? "";
        return dead.includes(p) ? Promise.reject(missingError(p)) : Promise.resolve(summaryAt(p));
      }
      case "commit_graph":
        return Promise.resolve(emptyGraph);
      case "working_changes":
        return Promise.resolve({ staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState });
      case "recents_status":
        return Promise.resolve(
          (args?.paths ?? []).map(
            (path) => statuses.find((s) => s.path === path) ?? { path, exists: false, branch: null, isWorktree: false },
          ),
        );
      default:
        return Promise.resolve([]);
    }
  };

const withTerminals = (...paths: string[]) => {
  for (const path of paths) useTerminals.getState().openTab(path);
};
const terminalRepos = () => Object.keys(useTerminals.getState().byRepo).sort();

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(invokeWithDead([]));
  dialogMock.mockReset();
  localStorage.clear();
  useRepo.setState(createInitialRepoData([], []));
  useTerminals.setState({ byRepo: {} });
});

describe("dropping a repo tab closes its terminals", () => {
  it("closeRepo", async () => {
    useRepo.setState({ summary: summaryAt("/a"), openPaths: ["/a", "/b"] });
    withTerminals("/a", "/b");

    await useRepo.getState().closeRepo("/b");

    expect(terminalRepos()).toEqual(["/a"]);
  });

  it("an in-place worktree switch (replaceTab) closes the replaced source's terminals", async () => {
    useRepo.setState({ summary: summaryAt("/wt-a"), openPaths: ["/main", "/wt-a"] });
    withTerminals("/main", "/wt-a");

    await useRepo.getState().loadRepo("/wt-b", { replaceTab: "/wt-a" });

    expect(useRepo.getState().openPaths).toEqual(["/main", "/wt-b"]);
    expect(terminalRepos()).toEqual(["/main"]);
  });

  it("retiring a background removed-worktree tab", async () => {
    useRepo.setState({
      summary: summaryAt("/main"),
      graph: emptyGraph,
      openPaths: ["/main", "/wt"],
      tabInfoByPath: { "/wt": worktreeInfo("/main") },
    });
    withTerminals("/main", "/wt");
    invokeMock.mockImplementation(invokeWithDead(["/wt"]));

    await useRepo.getState().loadRepo("/wt");

    expect(useRepo.getState().openPaths).toEqual(["/main"]);
    expect(terminalRepos()).toEqual(["/main"]);
  });

  it("falling back from a displayed removed worktree to its parent", async () => {
    useRepo.setState({
      summary: summaryAt("/wt", { isWorktree: true, mainPath: "/main" }),
      graph: emptyGraph,
      openPaths: ["/main", "/wt"],
      tabInfoByPath: { "/wt": worktreeInfo("/main") },
    });
    withTerminals("/main", "/wt");
    invokeMock.mockImplementation(invokeWithDead(["/wt"]));

    await useRepo.getState().refresh({ prs: false });

    expect(useRepo.getState().summary?.path).toBe("/main");
    expect(terminalRepos()).toEqual(["/main"]);
  });

  it("falling back from a lone removed worktree to the welcome screen", async () => {
    useRepo.setState({
      summary: summaryAt("/wt", { isWorktree: true, mainPath: "/main" }),
      graph: emptyGraph,
      openPaths: ["/wt"],
      tabInfoByPath: { "/wt": worktreeInfo("/main") },
    });
    withTerminals("/wt");
    invokeMock.mockImplementation(
      invokeWithDead(["/wt", "/main"], [{ path: "/main", exists: false, branch: null, isWorktree: false }]),
    );

    await useRepo.getState().refresh({ prs: false });

    expect(useRepo.getState().openPaths).toEqual([]);
    expect(terminalRepos()).toEqual([]);
  });

  it("Locate… re-keying the stale tab", async () => {
    useRepo.setState({
      missingRepo: { path: "/old", kind: "missing" },
      openPaths: ["/a", "/old"],
    });
    withTerminals("/a", "/old");
    dialogMock.mockResolvedValue("/new");

    await useRepo.getState().locateMissingRepo();

    expect(useRepo.getState().openPaths).toEqual(["/a", "/new"]);
    expect(terminalRepos()).toEqual(["/a"]);
  });
});
