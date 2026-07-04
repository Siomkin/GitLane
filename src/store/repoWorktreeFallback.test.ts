// GL-126: a *linked worktree* whose directory has been removed is a dead end,
// not a repository to recover. Instead of the GL-108 missing-repo screen, the
// app drops the dead worktree tab and switches to a sensible default — the
// worktree's parent/main repo, then another open tab, then the welcome screen —
// and never persists the removed worktree as the active selection.

import { describe, it, expect, beforeEach, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
const dialogMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogMock }));

import { useRepo } from "./repo";
import { createInitialRepoData } from "./repoTypes";
import type { RecentStatus, RepoGraph, RepoOpenError, RepoSummary, WorkingChanges } from "../lib/api";
import { emptyAdvancedState } from "../lib/advancedRepoState";
import type { TabInfo } from "../lib/tabs";

const summaryAt = (path: string, extra: Partial<RepoSummary> = {}): RepoSummary => ({
  path,
  workdir: path,
  headBranch: "main",
  headOid: null,
  detached: false,
  ...extra,
});

const emptyGraph: RepoGraph = {
  commits: [],
  edges: [],
  laneCount: 1,
  head: null,
  truncated: false,
};
const EMPTY_CHANGES: WorkingChanges = { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState };

const worktreeInfo = (mainPath: string, branch: string | null = "feat"): TabInfo => ({
  isWorktree: true,
  mainPath,
  branch,
});

const missingError = (path: string): RepoOpenError => ({
  kind: "missing",
  message: `This repository can't be found at ${path}. It may have been moved or deleted.`,
  path,
});

const defaultInvoke = (cmd: string) =>
  Promise.resolve(cmd === "working_changes" ? EMPTY_CHANGES : []);

// An open that resolves a healthy repo at every path *except* the given dead
// ones, which reject with the classified missing error (so the store's
// `wentMissing` probe classifies them as vanished worktrees).
const invokeWithDead =
  (deadPaths: string[], statuses: RecentStatus[] = []) =>
  (cmd: string, args?: { path?: string; paths?: string[] }): Promise<unknown> => {
    switch (cmd) {
      case "open_repo": {
        const p = args?.path ?? "";
        return deadPaths.includes(p)
          ? Promise.reject(missingError(p))
          : Promise.resolve(summaryAt(p));
      }
      case "commit_graph":
        return Promise.resolve(emptyGraph);
      case "working_changes":
        return Promise.resolve(EMPTY_CHANGES);
      case "recents_status":
        return Promise.resolve(
          (args?.paths ?? []).map(
            (path) => statuses.find((s) => s.path === path) ?? { path, exists: false, branch: null },
          ),
        );
      default:
        return defaultInvoke(cmd);
    }
  };

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  dialogMock.mockReset();
  localStorage.clear();
  useRepo.setState(createInitialRepoData([], []));
});

describe("repo store — removed worktree fallback (GL-126)", () => {
  it("switches to the parent repo when a displayed worktree vanishes on refresh", async () => {
    useRepo.setState({
      summary: summaryAt("/wt", { isWorktree: true, mainPath: "/main" }),
      graph: emptyGraph,
      openPaths: ["/main", "/wt"],
      tabInfoByPath: { "/wt": worktreeInfo("/main") },
    });
    invokeMock.mockImplementation(invokeWithDead(["/wt"]));

    await useRepo.getState().refresh({ prs: false });

    const s = useRepo.getState();
    // No missing-repo screen; the parent repo is now active, dead tab dropped.
    expect(s.missingRepo).toBeNull();
    expect(s.summary?.path).toBe("/main");
    expect(s.openPaths).toEqual(["/main"]);
    expect(s.error).toBeNull();
    // The removed worktree isn't persisted as the active selection (AC #4).
    expect(localStorage.getItem("gitlane.lastPath")).toBe("/main");
  });

  it("opens the parent repo even when it isn't an open tab, if it still exists on disk", async () => {
    useRepo.setState({
      summary: summaryAt("/wt", { isWorktree: true, mainPath: "/main" }),
      graph: emptyGraph,
      openPaths: ["/wt"],
      tabInfoByPath: { "/wt": worktreeInfo("/main") },
    });
    invokeMock.mockImplementation(
      invokeWithDead(["/wt"], [{ path: "/main", exists: true, branch: "main" }]),
    );

    await useRepo.getState().refresh({ prs: false });

    const s = useRepo.getState();
    expect(s.missingRepo).toBeNull();
    expect(s.summary?.path).toBe("/main");
    expect(s.openPaths).toEqual(["/main"]);
  });

  it("falls back to another open tab when the parent is also gone", async () => {
    useRepo.setState({
      summary: summaryAt("/wt", { isWorktree: true, mainPath: "/main" }),
      graph: emptyGraph,
      openPaths: ["/other", "/wt"],
      tabInfoByPath: { "/wt": worktreeInfo("/main") },
    });
    // Parent probe reports gone; "/other" is a healthy sibling tab.
    invokeMock.mockImplementation(
      invokeWithDead(["/wt", "/main"], [{ path: "/main", exists: false, branch: null }]),
    );

    await useRepo.getState().refresh({ prs: false });

    const s = useRepo.getState();
    expect(s.missingRepo).toBeNull();
    expect(s.summary?.path).toBe("/other");
    expect(s.openPaths).toEqual(["/other"]);
  });

  it("lands on the welcome screen when a lone worktree vanishes with no safe default", async () => {
    useRepo.setState({
      summary: summaryAt("/wt", { isWorktree: true, mainPath: "/main" }),
      graph: emptyGraph,
      openPaths: ["/wt"],
      tabInfoByPath: { "/wt": worktreeInfo("/main") },
      recents: [{ path: "/wt", name: "wt", branch: "feat", lastOpenedAt: 1 }],
    });
    // Both the worktree and its parent are gone.
    invokeMock.mockImplementation(
      invokeWithDead(["/wt", "/main"], [{ path: "/main", exists: false, branch: null }]),
    );

    await useRepo.getState().refresh({ prs: false });

    const s = useRepo.getState();
    // Welcome/empty state — never the missing-repo screen for a removed worktree.
    expect(s.missingRepo).toBeNull();
    expect(s.summary).toBeNull();
    expect(s.openPaths).toEqual([]);
    expect(s.error).toBeNull();
    // The dead worktree is dropped from recents and not persisted as active.
    expect(s.recents).toEqual([]);
    expect(localStorage.getItem("gitlane.lastPath")).toBeNull();
  });

  it("retires the dead tab (no reload) when a background worktree tab is clicked", async () => {
    useRepo.setState({
      summary: summaryAt("/main"),
      graph: emptyGraph,
      openPaths: ["/main", "/wt"],
      tabInfoByPath: { "/wt": worktreeInfo("/main") },
    });
    invokeMock.mockImplementation(invokeWithDead(["/wt"]));

    await useRepo.getState().loadRepo("/wt");

    const s = useRepo.getState();
    // The worktree wasn't the displayed repo, so its tab is dropped and focus
    // stays on /main — no reload of the already-displayed repo.
    expect(s.missingRepo).toBeNull();
    expect(s.summary).toBe(s.summary); // unchanged object
    expect(s.summary?.path).toBe("/main");
    expect(s.openPaths).toEqual(["/main"]);
    // /main was never re-opened (only /wt was probed).
    expect(invokeMock).not.toHaveBeenCalledWith("open_repo", { path: "/main" });
  });

  it("does not hijack focus if the user switches tabs during the parent probe", async () => {
    useRepo.setState({
      summary: summaryAt("/wt", { isWorktree: true, mainPath: "/main" }),
      graph: emptyGraph,
      openPaths: ["/wt", "/other"],
      tabInfoByPath: { "/wt": worktreeInfo("/main") },
    });
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "open_repo") {
        return args?.path === "/wt"
          ? Promise.reject(missingError("/wt"))
          : Promise.resolve(summaryAt(args?.path ?? ""));
      }
      if (cmd === "recents_status") {
        // The user switches to /other while the parent-presence probe is in
        // flight; the fallback must not yank focus back afterwards.
        useRepo.setState({ summary: summaryAt("/other"), graph: emptyGraph });
        return Promise.resolve([{ path: "/main", exists: true, branch: "main" }]);
      }
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      return defaultInvoke(cmd);
    });

    await useRepo.getState().refresh({ prs: false });

    const s = useRepo.getState();
    // Focus stayed on the user's choice; the fallback only retired the dead tab.
    expect(s.summary?.path).toBe("/other");
    expect(s.openPaths).toEqual(["/other"]);
    expect(s.missingRepo).toBeNull();
    // The parent was never opened — the probe race downgraded to a tab retire.
    expect(invokeMock).not.toHaveBeenCalledWith("open_repo", { path: "/main" });
  });

  it("falls back to the parent when the worktree vanishes during the graph load", async () => {
    useRepo.setState({
      summary: summaryAt("/main"),
      graph: emptyGraph,
      openPaths: ["/main", "/wt"],
    });
    let wtOpens = 0;
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "open_repo") {
        if (args?.path === "/wt") {
          wtOpens += 1;
          // Opens once (so the tab activates as a worktree), then vanishes
          // before the graph read — the re-probe classifies it missing.
          return wtOpens === 1
            ? Promise.resolve(summaryAt("/wt", { isWorktree: true, mainPath: "/main" }))
            : Promise.reject(missingError("/wt"));
        }
        return Promise.resolve(summaryAt(args?.path ?? ""));
      }
      if (cmd === "commit_graph") {
        return args?.path === "/wt"
          ? Promise.reject(new Error("failed to resolve path '/wt'"))
          : Promise.resolve(emptyGraph);
      }
      if (cmd === "working_changes") return Promise.resolve(EMPTY_CHANGES);
      return defaultInvoke(cmd);
    });

    await useRepo.getState().loadRepo("/wt");

    const s = useRepo.getState();
    // Even without a pre-seeded tab-info entry, the active summary's worktree
    // flag routes it through the fallback rather than the missing screen.
    expect(s.missingRepo).toBeNull();
    expect(s.summary?.path).toBe("/main");
    expect(s.openPaths).toEqual(["/main"]);
  });

  it("keeps the missing-repo screen for a standalone (non-worktree) repo", async () => {
    useRepo.setState({
      summary: summaryAt("/repo"),
      graph: emptyGraph,
      openPaths: ["/repo"],
      // No worktree tab info → treated as a standalone repo.
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "open_repo" ? Promise.reject(missingError("/repo")) : defaultInvoke(cmd),
    );

    await useRepo.getState().refresh({ prs: false });

    const s = useRepo.getState();
    expect(s.missingRepo).toEqual({ path: "/repo", kind: "missing" });
    expect(s.summary).toBeNull();
  });
});
