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
import type { RecentStatus, RepoGraph, CommandErrorPayload, RepoSummary, WorkingChanges } from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import type { TabInfo } from "@/lib/tabs";

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
  wipLane: null,
  head: null,
  truncated: false,
};
const EMPTY_CHANGES: WorkingChanges = { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState };

const worktreeInfo = (mainPath: string, branch: string | null = "feat"): TabInfo => ({
  isWorktree: true,
  mainPath,
  branch,
});

const missingError = (path: string): CommandErrorPayload => ({
  kind: "missingPath",
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
    await Promise.resolve();
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith("unwatch_repo", { path: "/wt" });
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

    const before = useRepo.getState().summary;
    await useRepo.getState().loadRepo("/wt");

    const s = useRepo.getState();
    // The worktree wasn't the displayed repo, so its tab is dropped and focus
    // stays on /main — no reload of the already-displayed repo (same object).
    expect(s.missingRepo).toBeNull();
    expect(s.summary).toBe(before);
    expect(s.openPaths).toEqual(["/main"]);
    // /main was never re-opened (only /wt was probed).
    expect(invokeMock).not.toHaveBeenCalledWith("open_repo", { path: "/main" });
  });

  it("does not switch away when a repo opens and completes during the parent probe", async () => {
    // The completed-switch race: the newer open publishes its summary and bumps
    // the graph generation before the probe resolves, so the caller's ownership
    // token (graph generation) is stale and the fallback must stand down.
    let resolveProbe: (v: RecentStatus[]) => void = () => {};
    const probe = new Promise<RecentStatus[]>((r) => {
      resolveProbe = r;
    });
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
      if (cmd === "recents_status") return probe; // held open
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      if (cmd === "working_changes") return Promise.resolve(EMPTY_CHANGES);
      return defaultInvoke(cmd);
    });

    const refreshing = useRepo.getState().refresh({ prs: false });
    // The user switches to /other; let that open fully complete.
    await useRepo.getState().loadRepo("/other");
    expect(useRepo.getState().summary?.path).toBe("/other");

    // Now the stale fallback's probe resolves — it must not steal focus back.
    resolveProbe([{ path: "/main", exists: true, branch: "main" }]);
    await refreshing;

    const s = useRepo.getState();
    expect(s.summary?.path).toBe("/other");
    expect(s.missingRepo).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("open_repo", { path: "/main" });
  });

  it("does not switch away when a repo switch is still in flight during the parent probe", async () => {
    // The in-flight race the summary/generation guards miss: the competing
    // loadRepo has *claimed its open intent* but not yet published its summary
    // or bumped the generation when the probe resolves. Only the captured open
    // intent flips in that window — the fallback must bail on it.
    let probeStarted: () => void = () => {};
    const started = new Promise<void>((r) => {
      probeStarted = r;
    });
    let resolveProbe: (v: RecentStatus[]) => void = () => {};
    const probe = new Promise<RecentStatus[]>((r) => {
      resolveProbe = r;
    });
    let resolveOther: (v: RepoSummary) => void = () => {};
    const otherOpen = new Promise<RepoSummary>((r) => {
      resolveOther = r;
    });
    useRepo.setState({
      summary: summaryAt("/wt", { isWorktree: true, mainPath: "/main" }),
      graph: emptyGraph,
      openPaths: ["/wt", "/other"],
      tabInfoByPath: { "/wt": worktreeInfo("/main") },
    });
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "open_repo") {
        if (args?.path === "/wt") return Promise.reject(missingError("/wt"));
        if (args?.path === "/other") return otherOpen; // held open (in flight)
        return Promise.resolve(summaryAt(args?.path ?? ""));
      }
      if (cmd === "recents_status") {
        probeStarted(); // the fallback has captured its entry intent by now
        return probe;
      }
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      if (cmd === "working_changes") return Promise.resolve(EMPTY_CHANGES);
      return defaultInvoke(cmd);
    });

    // Refresh detects /wt missing and parks on the parent probe.
    const refreshing = useRepo.getState().refresh({ prs: false });
    await started;
    // Switch is initiated (claims a newer open intent) but its open is pending.
    const switching = useRepo.getState().loadRepo("/other");
    // Probe resolves while /other is still opening — the fallback must bail.
    resolveProbe([{ path: "/main", exists: true, branch: "main" }]);
    await refreshing;
    // Let the in-flight switch finish.
    resolveOther(summaryAt("/other"));
    await switching;

    const s = useRepo.getState();
    expect(s.summary?.path).toBe("/other");
    expect(s.missingRepo).toBeNull();
    // The fallback never opened the parent — it stood down for the newer intent.
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

  it("does not strand the store loading when the fallback target's open fails", async () => {
    // The parent is already an open tab (no probe), so the fallback hands off to
    // loadRepo(/main) — whose initial open then fails with a *non-missing* error.
    // loadRepo's phase-1 catch only sets `error` (it assumes it never raised the
    // loading flags), so the fallback must not leave them stuck true.
    useRepo.setState({
      summary: summaryAt("/wt", { isWorktree: true, mainPath: "/main" }),
      graph: emptyGraph,
      openPaths: ["/main", "/wt"],
      tabInfoByPath: { "/wt": worktreeInfo("/main") },
    });
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "open_repo") {
        if (args?.path === "/wt") return Promise.reject(missingError("/wt"));
        return Promise.reject(new Error("disk I/O error")); // /main open fails, not missing
      }
      if (cmd === "working_changes") return Promise.resolve(EMPTY_CHANGES);
      return defaultInvoke(cmd);
    });

    await useRepo.getState().refresh({ prs: false });

    const s = useRepo.getState();
    // Dead worktree left behind, target never published — but not stuck loading.
    expect(s.summary).toBeNull();
    expect(s.missingRepo).toBeNull();
    expect(s.loading).toBe(false);
    expect(s.graphLoading).toBe(false);
    expect(s.error).toContain("disk I/O error");
    expect(s.openPaths).toEqual(["/main"]);
  });

  it("does not switch away on an in-flight switch when the parent is already open", async () => {
    // The parent-already-open synchronous path has no probe to re-guard on, so
    // the open-intent baseline must be captured by the *caller*. Here the repo
    // vanishes between refresh's open and its graph read, so wentMissing re-opens
    // /wt to classify it (an await); the user switches during that window. The
    // switch has claimed a newer intent but not published, so the fallback —
    // which would otherwise pick the already-open /main synchronously — must
    // stand down on the intent baseline refresh captured before its reads.
    let probeStarted: () => void = () => {};
    const started = new Promise<void>((r) => {
      probeStarted = r;
    });
    let resolveReprobe: () => void = () => {};
    const reprobe = new Promise<void>((r) => {
      resolveReprobe = r;
    });
    let resolveOther: (v: RepoSummary) => void = () => {};
    const otherOpen = new Promise<RepoSummary>((r) => {
      resolveOther = r;
    });
    useRepo.setState({
      summary: summaryAt("/wt", { isWorktree: true, mainPath: "/main" }),
      graph: emptyGraph,
      openPaths: ["/main", "/wt", "/other"],
      tabInfoByPath: { "/wt": worktreeInfo("/main") },
    });
    let wtOpens = 0;
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "open_repo") {
        if (args?.path === "/wt") {
          wtOpens += 1;
          // Refresh's own open succeeds; the repo then vanishes before the graph,
          // so wentMissing's re-probe (2nd open) reclassifies it missing — held
          // open so the switch can race the classify await.
          if (wtOpens === 1) {
            return Promise.resolve(summaryAt("/wt", { isWorktree: true, mainPath: "/main" }));
          }
          probeStarted();
          return reprobe.then(() => {
            throw missingError("/wt");
          });
        }
        if (args?.path === "/other") return otherOpen; // in flight
        return Promise.resolve(summaryAt(args?.path ?? ""));
      }
      if (cmd === "commit_graph") {
        // The worktree's graph read is what fails (a plain, non-classified
        // error), forcing wentMissing to re-probe with an await.
        return args?.path === "/wt"
          ? Promise.reject(new Error("failed to resolve path '/wt'"))
          : Promise.resolve(emptyGraph);
      }
      if (cmd === "working_changes") return Promise.resolve(EMPTY_CHANGES);
      return defaultInvoke(cmd);
    });

    const refreshing = useRepo.getState().refresh({ prs: false });
    await started;
    // Switch initiated (claims a newer intent) but its open is still pending.
    const switching = useRepo.getState().loadRepo("/other");
    // The classify re-probe resolves; the fallback must bail on the newer intent
    // rather than synchronously switching to the already-open /main.
    resolveReprobe();
    await refreshing;
    resolveOther(summaryAt("/other"));
    await switching;

    const s = useRepo.getState();
    expect(s.summary?.path).toBe("/other");
    expect(s.missingRepo).toBeNull();
    // The fallback never loaded /main (its open would be the healthy branch).
    expect(invokeMock).not.toHaveBeenCalledWith("open_repo", { path: "/main" });
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
