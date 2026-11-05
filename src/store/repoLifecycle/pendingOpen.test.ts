// The phase-1 pending-open marker (tab-open-progress): set the moment an open
// starts, cleared on every phase-1 exit, and owned only by the latest open.

import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { describe, it, expect, beforeEach, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRepo } from "@/store/repo";
import type { RepoSummary } from "@/lib/api";
import { defaultInvoke, deferred, emptyGraph } from "@/test/repoFixtures";

const summaryOf = (path: string): RepoSummary => ({
  path,
  workdir: path,
  headBranch: "main",
  headOid: null,
  detached: false,
  unborn: false,
  isWorktree: false,
});

/** `open_repo` answers from `opens` by path (a deferred or a plain summary). */
function mockOpens(opens: Record<string, Promise<RepoSummary>>) {
  invokeMock.mockImplementation((cmd: string, args: { path?: string }) => {
    if (cmd === "open_repo") return opens[args.path ?? ""] ?? Promise.resolve(summaryOf(args.path ?? ""));
    if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
    return defaultInvoke(cmd);
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve));

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(emptyIpcInvoke);
  useRepo.setState({
    summary: summaryOf("/current"),
    openPaths: ["/current", "/a", "/b"],
    pendingOpen: null,
    missingRepo: null,
    error: null,
  });
});

describe("repo store — pendingOpen", () => {
  it("is set before open_repo resolves and cleared with the published summary", async () => {
    const openA = deferred<RepoSummary>();
    mockOpens({ "/a": openA.promise });

    const load = useRepo.getState().loadRepo("/a");
    expect(useRepo.getState().pendingOpen?.path).toBe("/a");
    // The repo on screen is untouched while pending (GL-20).
    expect(useRepo.getState().summary?.path).toBe("/current");

    openA.resolve(summaryOf("/a"));
    await load;
    expect(useRepo.getState().summary?.path).toBe("/a");
    expect(useRepo.getState().pendingOpen).toBeNull();
  });

  it("is cleared when open_repo fails with a plain error", async () => {
    invokeMock.mockRejectedValueOnce(new Error("not a git repository"));
    await useRepo.getState().loadRepo("/a");
    expect(useRepo.getState().pendingOpen).toBeNull();
    expect(useRepo.getState().error).toContain("not a git repository");
  });

  it("is cleared when an SSH host is unreachable (disconnected state)", async () => {
    const remote = "ssh://devbox/srv/api";
    useRepo.setState({ openPaths: ["/current", remote] });
    invokeMock.mockImplementation((cmd: string, args?: { command?: string }) =>
      cmd === "remote_invoke" && args?.command === "open_repo"
        ? Promise.reject({ kind: "remoteUnavailable", code: "unreachable", message: "Could not connect to devbox." })
        : defaultInvoke(cmd),
    );
    await useRepo.getState().loadRepo(remote);
    expect(useRepo.getState().missingRepo).toEqual({ path: remote, kind: "disconnected" });
    expect(useRepo.getState().pendingOpen).toBeNull();
  });

  it.each([
    ["resolves", (d: ReturnType<typeof deferred<RepoSummary>>) => d.resolve(summaryOf("/a"))],
    ["rejects", (d: ReturnType<typeof deferred<RepoSummary>>) => d.reject(new Error("late failure"))],
  ])("stays on the newer open when a superseded one %s late", async (_, settle) => {
    const openA = deferred<RepoSummary>();
    const openB = deferred<RepoSummary>();
    mockOpens({ "/a": openA.promise, "/b": openB.promise });

    const loadA = useRepo.getState().loadRepo("/a");
    const loadB = useRepo.getState().loadRepo("/b");
    expect(useRepo.getState().pendingOpen?.path).toBe("/b");

    settle(openA);
    await loadA;
    await tick();
    expect(useRepo.getState().pendingOpen?.path).toBe("/b");

    openB.resolve(summaryOf("/b"));
    await loadB;
    expect(useRepo.getState().pendingOpen).toBeNull();
    expect(useRepo.getState().summary?.path).toBe("/b");
  });

  it("cancelPendingOpen keeps the repo on screen and drops the late result", async () => {
    const openA = deferred<RepoSummary>();
    mockOpens({ "/a": openA.promise });

    const load = useRepo.getState().loadRepo("/a");
    useRepo.getState().cancelPendingOpen();
    expect(useRepo.getState().pendingOpen).toBeNull();

    openA.reject(new Error("lost devbox"));
    await load;
    await tick();
    expect(useRepo.getState().summary?.path).toBe("/current");
    expect(useRepo.getState().error).toBeNull();
    expect(useRepo.getState().pendingOpen).toBeNull();
  });

  it("marks the replaced tab for an in-place switch", async () => {
    const openWt = deferred<RepoSummary>();
    mockOpens({ "/current-wt": openWt.promise });
    const load = useRepo.getState().loadRepo("/current-wt", { replaceTab: "/current" });
    expect(useRepo.getState().pendingOpen).toEqual({ path: "/current-wt", tab: "/current" });
    openWt.resolve(summaryOf("/current-wt"));
    await load;
    expect(useRepo.getState().pendingOpen).toBeNull();
  });

  it("is cleared when the pending tab is closed, and the late open does not re-add it", async () => {
    const openA = deferred<RepoSummary>();
    mockOpens({ "/a": openA.promise });

    const load = useRepo.getState().loadRepo("/a");
    await useRepo.getState().closeRepo("/a");
    expect(useRepo.getState().pendingOpen).toBeNull();

    openA.resolve(summaryOf("/a"));
    await load;
    await tick();
    expect(useRepo.getState().openPaths).not.toContain("/a");
    expect(useRepo.getState().pendingOpen).toBeNull();
  });
});
