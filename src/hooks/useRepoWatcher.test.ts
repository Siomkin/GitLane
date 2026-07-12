import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoSummary } from "@/lib/api";
import { useRepo } from "@/store/repo";
import type { RefreshScope, RepoChangedEvent } from "./repoWatcher";
import { useRepoWatcher } from "./useRepoWatcher";

type RefreshFn = (opts?: { prs?: boolean; quiet?: boolean; scope?: RefreshScope }) => void;
type RefreshTabInfoFn = (path: string) => Promise<void>;

// Capture the `repo-changed` handler the hook registers so tests can drive
// events directly, standing in for the backend watcher.
const handlers: Array<(e: { payload: RepoChangedEvent }) => void> = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, handler: (e: { payload: RepoChangedEvent }) => void) => {
    handlers.push(handler);
    return Promise.resolve(() => {});
  }),
}));

const summaryAt = (path: string): RepoSummary => ({
  path,
  workdir: path,
  headBranch: "main",
  headOid: null,
  detached: false,
  isWorktree: false,
  mainPath: null,
});

/** Deliver one `repo-changed` event to the most recently mounted hook. */
function emit(payload: RepoChangedEvent) {
  const handler = handlers[handlers.length - 1];
  act(() => handler({ payload }));
}

/** Fire the debounce window (400ms) the hook batches events over. */
function flushDebounce() {
  act(() => vi.advanceTimersByTime(400));
}

describe("useRepoWatcher — event routing (GL-116)", () => {
  let refresh: ReturnType<typeof vi.fn<RefreshFn>>;
  let refreshTabInfo: ReturnType<typeof vi.fn<RefreshTabInfoFn>>;

  beforeEach(() => {
    vi.useFakeTimers();
    handlers.length = 0;
    refresh = vi.fn<RefreshFn>();
    refreshTabInfo = vi.fn<RefreshTabInfoFn>();
    // Active repo /a; /b is an open background tab; /x is unknown.
    useRepo.setState({
      summary: summaryAt("/a"),
      openPaths: ["/a", "/b"],
      refreshTabInfo,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-syncs the active repo, scoped by the event kind", () => {
    renderHook(() => useRepoWatcher(refresh));

    emit({ kind: "worktree", path: "/a" });
    flushDebounce();
    expect(refresh).toHaveBeenCalledWith({ prs: false, quiet: true, scope: "worktree" });
    expect(refreshTabInfo).not.toHaveBeenCalled();
  });

  it("upgrades the active repo's burst to a full sync on a graph event", () => {
    renderHook(() => useRepoWatcher(refresh));

    // A worktree event followed by a graph event in one window → scope "all".
    emit({ kind: "worktree", path: "/a" });
    emit({ kind: "graph", path: "/a" });
    flushDebounce();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({ prs: false, quiet: true, scope: "all" });
  });

  it("re-probes a background tab's label on a graph event, without re-syncing", () => {
    renderHook(() => useRepoWatcher(refresh));

    emit({ kind: "graph", path: "/b" });
    flushDebounce();
    expect(refreshTabInfo).toHaveBeenCalledWith("/b");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("ignores worktree-only churn in a background tab (label can't change)", () => {
    renderHook(() => useRepoWatcher(refresh));

    emit({ kind: "worktree", path: "/b" });
    flushDebounce();
    expect(refreshTabInfo).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("drops events for a path that isn't open", () => {
    renderHook(() => useRepoWatcher(refresh));

    emit({ kind: "graph", path: "/x" });
    flushDebounce();
    expect(refresh).not.toHaveBeenCalled();
    expect(refreshTabInfo).not.toHaveBeenCalled();
  });

  // GL-125: routing normalizes paths, so a trailing-separator representation
  // still lands on the right tab instead of silently dropping its events.
  it("routes a trailing-slash active-repo path via normalization", () => {
    renderHook(() => useRepoWatcher(refresh));

    emit({ kind: "worktree", path: "/a/" });
    flushDebounce();
    expect(refresh).toHaveBeenCalledWith({ prs: false, quiet: true, scope: "worktree" });
  });

  it("routes a trailing-slash background path and probes the openPaths string", () => {
    renderHook(() => useRepoWatcher(refresh));

    emit({ kind: "graph", path: "/b/" });
    flushDebounce();
    // Downstream uses the tab's own `openPaths` entry, not the raw payload path.
    expect(refreshTabInfo).toHaveBeenCalledWith("/b");
    expect(refresh).not.toHaveBeenCalled();
  });
});
