import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoSummary, WorktreeInfo } from "@/lib/api";

// Record every dirty probe so the trigger policy (the whole point of the module)
// is observable. `gate` lets a test hold probes open to drive the in-flight
// paths; `dirtyPaths` says which worktrees come back dirty.
const { probed, dirtyPaths, gate } = vi.hoisted(() => ({
  probed: [] as string[],
  dirtyPaths: new Set<string>(),
  gate: { pending: [] as Array<() => void>, hold: false },
}));

vi.mock("@/lib/api", () => ({
  api: {
    worktreeIsDirty: (path: string) => {
      probed.push(path);
      const answer = dirtyPaths.has(path);
      if (!gate.hold) return Promise.resolve(answer);
      return new Promise<boolean>((resolve) => gate.pending.push(() => resolve(answer)));
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

/** Let the batched fan-out and its `.then`/`.finally` settle. */
async function tick() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/** Release every parked probe and let the chain settle. */
async function release() {
  const pending = gate.pending.splice(0);
  pending.forEach((resolve) => resolve());
  await tick();
}

describe("probeDirtyWorktrees", () => {
  beforeEach(() => {
    probed.length = 0;
    dirtyPaths.clear();
    gate.pending.length = 0;
    gate.hold = false;
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

  it("does not re-probe an unchanged worktree set on ordinary refreshes", async () => {
    // Our own commits and checkouts drive full refreshes and can't dirty someone
    // else's checkout — re-probing on each one would be pure cost.
    vi.useFakeTimers();
    const { get, set } = fakeStore();
    probeDirtyWorktrees(set, get);
    await tick();
    expect(probed).toHaveLength(2);

    vi.advanceTimersByTime(5_000);
    probeDirtyWorktrees(set, get);
    probeDirtyWorktrees(set, get);
    await tick();
    expect(probed).toHaveLength(2);

    // …but it doesn't go stale forever: a slow backstop eventually re-reads.
    vi.advanceTimersByTime(30_000);
    probeDirtyWorktrees(set, get);
    await tick();
    expect(probed).toHaveLength(4);
  });

  it("re-probes an unchanged set when forced (the window regained focus)", async () => {
    vi.useFakeTimers();
    const { get, set } = fakeStore();
    probeDirtyWorktrees(set, get);
    await tick();
    expect(probed).toHaveLength(2);

    vi.advanceTimersByTime(2_000);
    probeDirtyWorktrees(set, get, { force: true });
    await tick();
    expect(probed).toHaveLength(4);

    // A forced probe still respects the short floor: alt-tab fires `focus` and
    // `visibilitychange` together, and a user can flick between windows.
    probeDirtyWorktrees(set, get, { force: true });
    await tick();
    expect(probed).toHaveLength(4);
  });

  it("bypasses every interval when the worktree set itself changed", async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    probeDirtyWorktrees(store.set, store.get);
    await tick();
    expect(probed).toHaveLength(2);

    // A worktree appeared — it has no answer yet, so waiting would show no dot.
    store.state.worktrees = [...store.state.worktrees, wt({ name: "wt-c", path: "/wt-c", isMain: false })];
    probeDirtyWorktrees(store.set, store.get);
    await tick();
    expect(probed).toEqual(["/wt-a", "/wt-b", "/wt-a", "/wt-b", "/wt-c"]);
  });

  it("replays a request that arrived while a probe was in flight", async () => {
    // Without this the newly opened repo would show no dots until some later
    // refresh happened to come along.
    gate.hold = true;
    const store = fakeStore();
    probeDirtyWorktrees(store.set, store.get);
    await tick();
    expect(probed).toEqual(["/wt-a", "/wt-b"]);

    // Repo switched while those statuses were still running.
    store.state.summary = summary("/other");
    store.state.worktrees = [wt({ path: "/other", isMain: true }), wt({ name: "wt-z", path: "/wt-z", isMain: false })];
    probeDirtyWorktrees(store.set, store.get);
    expect(probed).toHaveLength(2);

    gate.hold = false;
    await release();
    expect(probed).toEqual(["/wt-a", "/wt-b", "/wt-z"]);
  });

  it("drops answers that arrive after a repo switch", async () => {
    dirtyPaths.add("/wt-a");
    gate.hold = true;
    const store = fakeStore();
    probeDirtyWorktrees(store.set, store.get);
    await tick();
    // The user switched repos while the statuses were running: these answers
    // describe the repo we left.
    store.state.summary = summary("/other");
    store.state.worktrees = [wt({ path: "/other", isMain: true })];
    gate.hold = false;
    await release();
    expect(store.state.dirtyWorktrees).toEqual([]);
  });

  it("drops the answer for a worktree removed mid-probe, keeping its siblings", async () => {
    dirtyPaths.add("/wt-a");
    dirtyPaths.add("/wt-b");
    gate.hold = true;
    const store = fakeStore();
    probeDirtyWorktrees(store.set, store.get);
    await tick();
    // wt-a was removed while its status ran — measured, but no longer ours to
    // describe. wt-b's answer is still valid: it was measured by path.
    store.state.worktrees = [wt(), detached];
    gate.hold = false;
    await release();
    expect(store.state.dirtyWorktrees).toEqual(["/wt-b"]);
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

  it("spreads the statuses rather than launching all of them at once", async () => {
    // A directory full of agent worktrees must not put N `git status` processes
    // on the disk simultaneously; the pass is fire-and-forget, so only its peak
    // cost matters, not its wall time.
    gate.hold = true;
    const many = Array.from({ length: 9 }, (_, i) =>
      wt({ name: `wt-${i}`, path: `/wt-${i}`, isMain: false }),
    );
    const store = fakeStore({ worktrees: [wt(), ...many] });
    probeDirtyWorktrees(store.set, store.get);
    await tick();
    expect(probed).toHaveLength(4);

    await release();
    expect(probed).toHaveLength(8);

    await release();
    expect(probed).toHaveLength(9);
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
