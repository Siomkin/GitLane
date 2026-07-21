import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoSummary, WorktreeInfo } from "@/lib/api";

// Record every dirty probe so the throttle (the whole point of the module) is
// observable, and let each test say which worktrees come back dirty.
const { probed, dirtyPaths } = vi.hoisted(() => ({
  probed: [] as string[],
  dirtyPaths: new Set<string>(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    worktreeIsDirty: (path: string) => {
      probed.push(path);
      return Promise.resolve(dirtyPaths.has(path));
    },
  },
}));

import { probeDirtyWorktrees, resetWorktreeDirtyProbe } from "./repoWorktreeDirty";

const summary = (path = "/repo"): RepoSummary => ({
  path,
  workdir: path,
  headBranch: "main",
  headOid: "c1",
  detached: false,
});

const wt = (over: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  name: "repo",
  path: "/repo",
  branch: "main",
  isMain: true,
  ...over,
});

const linked = wt({ name: "wt-a", path: "/wt-a", branch: "feature", isMain: false });
const detached = wt({ name: "wt-b", path: "/wt-b", branch: null, isMain: false });

/** A minimal store stand-in: the probe only reads summary/worktrees/dirtyWorktrees
 * and only writes dirtyWorktrees. */
function fakeStore(over: { worktrees?: WorktreeInfo[]; summary?: RepoSummary | null } = {}) {
  const state = {
    summary: over.summary === undefined ? summary() : over.summary,
    worktrees: over.worktrees ?? [wt(), linked, detached],
    dirtyWorktrees: [] as string[],
  };
  const get = (() => state) as never;
  const set = ((patch: { dirtyWorktrees: string[] }) => {
    Object.assign(state, patch);
  }) as never;
  return { state, get, set };
}

/** Let the Promise.all fan-out and its `.then` settle. */
async function tick() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("probeDirtyWorktrees", () => {
  beforeEach(() => {
    probed.length = 0;
    dirtyPaths.clear();
    resetWorktreeDirtyProbe();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes the dirty paths among the other worktrees", async () => {
    dirtyPaths.add("/wt-b");
    const { state, get, set } = fakeStore();
    probeDirtyWorktrees(set, get);
    await tick();
    // The open worktree (/repo) is never probed — the WIP row covers it.
    expect(probed).toEqual(["/wt-a", "/wt-b"]);
    expect(state.dirtyWorktrees).toEqual(["/wt-b"]);
  });

  it("throttles re-probes of an unchanged worktree set", async () => {
    vi.useFakeTimers();
    const { get, set } = fakeStore();
    probeDirtyWorktrees(set, get);
    await tick();
    expect(probed).toHaveLength(2);

    // A burst of refreshes (a rebase, a busy checkout) must not become a burst
    // of `git status` calls.
    probeDirtyWorktrees(set, get);
    probeDirtyWorktrees(set, get);
    await tick();
    expect(probed).toHaveLength(2);

    vi.advanceTimersByTime(2_000);
    probeDirtyWorktrees(set, get);
    await tick();
    expect(probed).toHaveLength(4);
  });

  it("bypasses the throttle when the worktree set itself changed", async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    probeDirtyWorktrees(store.set, store.get);
    await tick();
    expect(probed).toHaveLength(2);

    // A worktree was added — genuinely new information, not a re-read.
    store.state.worktrees = [...store.state.worktrees, wt({ name: "wt-c", path: "/wt-c", isMain: false })];
    probeDirtyWorktrees(store.set, store.get);
    await tick();
    expect(probed).toEqual(["/wt-a", "/wt-b", "/wt-a", "/wt-b", "/wt-c"]);
  });

  it("clears the dots when no other worktree is left to probe", async () => {
    const store = fakeStore();
    store.state.dirtyWorktrees = ["/wt-a"];
    store.state.worktrees = [wt()];
    probeDirtyWorktrees(store.set, store.get);
    await tick();
    expect(probed).toEqual([]);
    expect(store.state.dirtyWorktrees).toEqual([]);
  });

  it("drops answers that arrive after a repo switch", async () => {
    dirtyPaths.add("/wt-a");
    const store = fakeStore();
    probeDirtyWorktrees(store.set, store.get);
    // The user switched repos while the statuses were running: these answers
    // describe the repo we left.
    store.state.summary = summary("/other");
    await tick();
    expect(store.state.dirtyWorktrees).toEqual([]);
  });

  it("treats a failed probe as clean rather than failing the whole pass", async () => {
    dirtyPaths.add("/wt-b");
    const store = fakeStore();
    const api = (await import("@/lib/api")).api as unknown as {
      worktreeIsDirty: (path: string) => Promise<boolean>;
    };
    const original = api.worktreeIsDirty;
    api.worktreeIsDirty = (path: string) =>
      path === "/wt-a" ? Promise.reject(new Error("boom")) : original(path);
    probeDirtyWorktrees(store.set, store.get);
    await tick();
    api.worktreeIsDirty = original;
    expect(store.state.dirtyWorktrees).toEqual(["/wt-b"]);
  });
});
