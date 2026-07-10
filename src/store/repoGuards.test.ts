// The store-side ownership guards (GL-158). `get` is mocked with a minimal
// state shape; the graph-generation and deferred-refresh state come from the
// real repoRequests module, exercised the way the slices drive it.
import { describe, expect, it, vi } from "vitest";

import { flushPendingRefresh, graphRequestIsCurrent, repoStillDisplayed } from "./repoGuards";
import { beginGraphRequest, deferRefresh, takePendingRefresh } from "./repoRequests";
import type { RepoGet, RepoState } from "./repoTypes";

const getFor = (state: Partial<RepoState>) => (() => state) as unknown as RepoGet;

describe("graphRequestIsCurrent", () => {
  it("requires both the latest generation and the displayed path", () => {
    const get = getFor({ summary: { path: "/repo" } as RepoState["summary"] });
    const generation = beginGraphRequest();
    expect(graphRequestIsCurrent(get, generation, "/repo")).toBe(true);
    expect(graphRequestIsCurrent(get, generation, "/other")).toBe(false);
    // A newer request supersedes the old generation even on the same path.
    beginGraphRequest();
    expect(graphRequestIsCurrent(get, generation, "/repo")).toBe(false);
  });
});

describe("repoStillDisplayed", () => {
  it("tracks the published summary path, failing closed on none", () => {
    expect(repoStillDisplayed(getFor({ summary: { path: "/repo" } as RepoState["summary"] }), "/repo")).toBe(true);
    expect(repoStillDisplayed(getFor({ summary: { path: "/repo" } as RepoState["summary"] }), "/other")).toBe(false);
    expect(repoStillDisplayed(getFor({ summary: null }), "/repo")).toBe(false);
  });
});

describe("flushPendingRefresh", () => {
  it("replays a deferred re-sync once, quiet and PR-free, with the queued scope", () => {
    const refresh = vi.fn(async () => {});
    const get = getFor({ refresh: refresh as unknown as RepoState["refresh"] });
    deferRefresh("worktree");
    flushPendingRefresh(get);
    expect(refresh).toHaveBeenCalledWith({ prs: false, quiet: true, scope: "worktree" });
    // The queue is drained — a second flush is a no-op.
    refresh.mockClear();
    flushPendingRefresh(get);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps the most permissive scope when both kinds were deferred", () => {
    const refresh = vi.fn(async () => {});
    const get = getFor({ refresh: refresh as unknown as RepoState["refresh"] });
    deferRefresh("worktree");
    deferRefresh("all");
    flushPendingRefresh(get);
    expect(refresh).toHaveBeenCalledWith({ prs: false, quiet: true, scope: "all" });
    expect(takePendingRefresh()).toBeNull();
  });
});
