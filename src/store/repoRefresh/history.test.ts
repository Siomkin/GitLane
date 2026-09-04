// Loading more history, reconciling an open diff, and read-request ownership.
//
// Split out of the former src/store/repo.test.ts, which reached 5 122 lines;
// shared data fixtures live in @/test/repoFixtures.

import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { usePulls } from "@/store/pulls";
import { ForgeKind } from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the IPC boundary so the store's async actions run headlessly. `vi.mock`
// is hoisted above the import below; `vi.hoisted` makes `invokeMock` exist in time.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRepo } from "@/store/repo";
import { EMPTY_CHANGES, defaultInvoke, deferred, emptyGraph, node, summary } from "@/test/repoFixtures";
import type {
  BranchInfo,
  RepoForge,
  RepoGraph,
  RepoSummary,
  WorkingChanges,
} from "@/lib/api";

const realRefresh = useRepo.getState().refresh;
beforeEach(() => {
  invokeMock.mockReset();
  // Fire-and-forget IPC (e.g. watch/unwatch on tab open/close) must resolve
  // rather than return `undefined`, and every wrapper now validates its result
  // (GL-57) — so answer each command's schema-valid empty payload (a "" status
  // for writes); tests that care set their own impl.
  invokeMock.mockImplementation(emptyIpcInvoke);
  useRepo.setState({
    summary,
    selectedFile: null,
    fileSelectionRequestId: 0,
    fileDiff: null,
    selectedCommit: null,
    inspectParentIndex: 0,
    graphLimit: 2_000,
    loadingMoreHistory: false,
    fetchingPath: null,
    refresh: realRefresh,
  });
});

describe("repo store — large history", () => {
  it("loads the next graph page and preserves the larger limit", async () => {
    useRepo.setState({
      graph: {
        commits: [],
        edges: [],
        laneCount: 1,
        wipLane: null,
        head: null,
        truncated: true,
      },
      selectedCommit: "selected",
      selectedCommits: ["selected"],
    });
    invokeMock.mockResolvedValueOnce({
      commits: [node({ id: "selected" })],
      edges: [],
      laneCount: 1,
      wipLane: null,
      head: "selected",
      truncated: false,
    });

    await useRepo.getState().loadMoreHistory();

    expect(invokeMock).toHaveBeenCalledWith("commit_graph", {
      path: "/repo",
      limit: 4_000,
    });
    expect(useRepo.getState().graphLimit).toBe(4_000);
    expect(useRepo.getState().selectedCommit).toBe("selected");
    expect(useRepo.getState().loadingMoreHistory).toBe(false);
  });

  it("uses a worktree-only watcher refresh without rebuilding the graph", async () => {
    const graph = {
      commits: [],
      edges: [],
      laneCount: 1,
      wipLane: null,
      head: null,
      truncated: false,
    };
    useRepo.setState({ graph });
    // A worktree refresh reads working changes + operation status, but never
    // rebuilds the graph.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      if (cmd === "operation_status")
        return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
      return defaultInvoke(cmd);
    });

    await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });

    expect(invokeMock).toHaveBeenCalledWith("working_changes", { path: "/repo" });
    expect(invokeMock).not.toHaveBeenCalledWith("commit_graph", expect.anything());
    expect(useRepo.getState().graph).toBe(graph);
  });

  it("sets and clears operationAdvisory from operation_status (git am / bisect)", async () => {
    const status = (advisory: string) =>
      Promise.resolve({ kind: "none", canSkip: false, conflicts: [], advisory });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [], conflicted: [] });
      if (cmd === "operation_status") return status("bisect");
      return defaultInvoke(cmd);
    });
    await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
    expect(useRepo.getState().operationAdvisory).toBe("bisect");

    // A subsequent clean status (empty advisory) clears it.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [], conflicted: [] });
      if (cmd === "operation_status") return status("");
      return defaultInvoke(cmd);
    });
    await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
    expect(useRepo.getState().operationAdvisory).toBeNull();
  });

  it("clears a WIP selection when a worktree refresh becomes clean", async () => {
    useRepo.setState({ wipSelected: true });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      if (cmd === "operation_status")
        return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
      return defaultInvoke(cmd);
    });

    await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });

    expect(useRepo.getState().wipSelected).toBe(false);
  });

  // GL-123: the watcher refresh must also reconcile the diff of the file open in
  // the viewer (`fileDiff`), so an external edit lands live instead of staying
  // stale until re-click.
  describe("open-diff reconcile", () => {
    // A minimal schema-valid FileDiff (lib/api validates the file_diff shape).
    const diff = (over: Partial<import("@/lib/api").FileDiff> = {}) => ({
      path: "src/a.ts",
      status: "M" as const,
      add: 1,
      del: 0,
      binary: false,
      hunks: [],
      truncated: false,
      ...over,
    });

    it("refetches the open unstaged file's diff on a worktree refresh", async () => {
      const oldDiff = diff({ add: 0 });
      const newDiff = diff({ add: 9 });
      useRepo.setState({
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: oldDiff,
      });
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "src/a.ts", status: "M", add: 9, del: 0, binary: false }],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        if (cmd === "file_diff") return Promise.resolve(newDiff);
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      // The reconcile is fire-and-forget — flush the microtask queue before asserting.
      await vi.waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("file_diff", {
          path: "/repo",
          file: "src/a.ts",
          staged: false,
          full: true,
        }),
      );
      expect(useRepo.getState().fileDiff).toEqual(newDiff);
    });

    it("never flips diffLoading while reconciling", async () => {
      const slow = deferred<ReturnType<typeof diff>>();
      useRepo.setState({
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: diff(),
        diffLoading: false,
      });
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        if (cmd === "file_diff") return slow.promise;
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      // With the file_diff still pending, the reconcile must not have raised the spinner.
      expect(useRepo.getState().diffLoading).toBe(false);
      slow.resolve(diff({ add: 3 }));
      await vi.waitFor(() => expect(useRepo.getState().fileDiff?.add).toBe(3));
      expect(useRepo.getState().diffLoading).toBe(false);
    });

    it("refetches full when the shown diff is not truncated, capped when it is", async () => {
      const base = {
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState } as WorkingChanges,
        selectedFile: { path: "src/a.ts", source: "unstaged" as const },
      };
      const worktreeInvoke = (cmd: string) => {
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        if (cmd === "file_diff") return Promise.resolve(diff());
        return defaultInvoke(cmd);
      };

      useRepo.setState({ ...base, fileDiff: diff({ truncated: false }) });
      invokeMock.mockImplementation(worktreeInvoke);
      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      await vi.waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("file_diff", expect.objectContaining({ full: true })),
      );

      invokeMock.mockReset();
      useRepo.setState({ ...base, fileDiff: diff({ truncated: true }) });
      invokeMock.mockImplementation(worktreeInvoke);
      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      await vi.waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("file_diff", expect.objectContaining({ full: false })),
      );
    });

    it("never refetches for a commit-source selection", async () => {
      useRepo.setState({
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
        selectedFile: { path: "src/a.ts", source: "commit" },
        fileDiff: diff(),
      });
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      await Promise.resolve();
      expect(invokeMock).not.toHaveBeenCalledWith("file_diff", expect.anything());
    });

    it("clears the selection and skips the refetch when the open file vanished", async () => {
      useRepo.setState({
        changes: {
          staged: [],
          unstaged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
          conflicted: [],
          advanced: emptyAdvancedState,
        },
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: diff(),
      });
      invokeMock.mockImplementation((cmd: string) => {
        // The file is gone from both buckets — committed/discarded outside the app.
        if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      await Promise.resolve();
      expect(useRepo.getState().selectedFile).toBeNull();
      expect(useRepo.getState().fileDiff).toBeNull();
      expect(invokeMock).not.toHaveBeenCalledWith("file_diff", expect.anything());
    });

    it("reconciles the open diff on an all-scope refresh too", async () => {
      const newDiff = diff({ add: 7 });
      useRepo.setState({
        graph: emptyGraph,
        selectedCommit: null,
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: diff({ add: 0 }),
      });
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "open_repo") return Promise.resolve(summary);
        if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "src/a.ts", status: "M", add: 7, del: 0, binary: false }],
          });
        if (cmd === "file_diff") return Promise.resolve(newDiff);
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false });
      await vi.waitFor(() => expect(useRepo.getState().fileDiff).toEqual(newDiff));
      expect(invokeMock).toHaveBeenCalledWith(
        "file_diff",
        expect.objectContaining({ path: "/repo", file: "src/a.ts", staged: false }),
      );
    });

    it("a stale reconcile cannot clobber a newer selection", async () => {
      const slow = deferred<ReturnType<typeof diff>>();
      const newerDiff = diff({ path: "src/b.ts", add: 5 });
      useRepo.setState({
        changes: {
          staged: [],
          unstaged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
          conflicted: [],
          advanced: emptyAdvancedState,
        },
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: diff(),
      });
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        if (cmd === "file_diff") return slow.promise;
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      // Before the in-flight reconcile resolves, the user selects another file.
      useRepo.setState({
        selectedFile: { path: "src/b.ts", source: "unstaged" },
        fileDiff: newerDiff,
      });
      slow.resolve(diff({ path: "src/a.ts", add: 99 }));
      await slow.promise;
      await Promise.resolve();
      expect(useRepo.getState().fileDiff).toEqual(newerDiff);
    });

    it("a capped reconcile cannot downgrade a diff expanded while it was in flight", async () => {
      const slow = deferred<ReturnType<typeof diff>>();
      const expanded = diff({ truncated: false, add: 4 });
      useRepo.setState({
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
        // The shown diff is truncated, so the reconcile fetches capped.
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: diff({ truncated: true }),
      });
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        if (cmd === "file_diff") return slow.promise;
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      // "Show full" lands while the capped reconcile is still in flight.
      useRepo.setState({ fileDiff: expanded });
      slow.resolve(diff({ truncated: true, add: 2 }));
      await slow.promise;
      await Promise.resolve();
      expect(useRepo.getState().fileDiff).toEqual(expanded);
    });

    it("fetches the staged diff for a staged selection", async () => {
      useRepo.setState({
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
        selectedFile: { path: "src/a.ts", source: "staged" },
        fileDiff: diff(),
      });
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
            unstaged: [],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        if (cmd === "file_diff") return Promise.resolve(diff({ add: 2 }));
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      await vi.waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("file_diff", expect.objectContaining({ staged: true })),
      );
      expect(useRepo.getState().fileDiff?.add).toBe(2);
    });

    it("a stale reconcile cannot leak an unstaged diff into a staged selection of the same path", async () => {
      const slow = deferred<ReturnType<typeof diff>>();
      const stagedDiff = diff({ add: 5 });
      useRepo.setState({
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: diff(),
      });
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [{ path: "src/a.ts", status: "M", add: 5, del: 0, binary: false }],
            unstaged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        if (cmd === "file_diff") return slow.promise;
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      // Same path, other bucket: the user clicks the staged row mid-reconcile.
      useRepo.setState({
        selectedFile: { path: "src/a.ts", source: "staged" },
        fileDiff: stagedDiff,
      });
      slow.resolve(diff({ add: 99 }));
      await slow.promise;
      await Promise.resolve();
      expect(useRepo.getState().fileDiff).toEqual(stagedDiff);
    });

    it("out-of-order reconciles resolve newest-wins for the same file", async () => {
      const slow = deferred<ReturnType<typeof diff>>();
      const newDiff = diff({ add: 8 });
      useRepo.setState({
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: diff({ add: 0 }),
      });
      let diffCalls = 0;
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "src/a.ts", status: "M", add: 8, del: 0, binary: false }],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        // The first tick's fetch stalls; the second tick's resolves immediately.
        if (cmd === "file_diff") return ++diffCalls === 1 ? slow.promise : Promise.resolve(newDiff);
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      await vi.waitFor(() => expect(useRepo.getState().fileDiff).toEqual(newDiff));
      // The older response lands last but must not publish over the newer one.
      slow.resolve(diff({ add: 99 }));
      await slow.promise;
      await Promise.resolve();
      expect(useRepo.getState().fileDiff).toEqual(newDiff);
    });

    it("skips publishing while a foreground diff load is in flight", async () => {
      const slow = deferred<ReturnType<typeof diff>>();
      const shown = diff({ add: 1 });
      useRepo.setState({
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: shown,
        diffLoading: false,
      });
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        if (cmd === "file_diff") return slow.promise;
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      // A selectFile/loadFullFileDiff raised the spinner mid-reconcile: it owns
      // the pane and will land fresher content, so the reconcile must not publish.
      useRepo.setState({ diffLoading: true });
      slow.resolve(diff({ add: 42 }));
      await slow.promise;
      await Promise.resolve();
      expect(useRepo.getState().fileDiff).toEqual(shown);
    });

    it("a stale reconcile cannot overwrite a completed foreground re-select of the same file", async () => {
      const slow = deferred<ReturnType<typeof diff>>();
      const foreground = diff({ add: 6 });
      useRepo.setState({
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: diff(),
        diffLoading: false,
      });
      let diffCalls = 0;
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "src/a.ts", status: "M", add: 6, del: 0, binary: false }],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        // The reconcile's fetch stalls; the user's re-click resolves immediately.
        if (cmd === "file_diff") return ++diffCalls === 1 ? slow.promise : Promise.resolve(foreground);
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      // The user re-clicks the same row; selectFile completes (diffLoading back
      // to false) before the reconcile's slower response lands.
      const requestId = useRepo.getState().fileSelectionRequestId;
      await useRepo.getState().selectFile("src/a.ts", "unstaged");
      expect(useRepo.getState().fileDiff).toEqual(foreground);
      expect(useRepo.getState().fileSelectionRequestId).toBe(requestId + 1);
      slow.resolve(diff({ add: 99 }));
      await slow.promise;
      await Promise.resolve();
      expect(useRepo.getState().fileDiff).toEqual(foreground);
    });

    it("keeps the selection source when the file moved buckets, showing its (empty) diff", async () => {
      const emptyDiff = diff({ add: 0, del: 0 });
      useRepo.setState({
        changes: {
          staged: [],
          unstaged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
          conflicted: [],
          advanced: emptyAdvancedState,
        },
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: diff(),
        diffLoading: false,
      });
      invokeMock.mockImplementation((cmd: string) => {
        // The file was fully staged outside the app: present in staged only.
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
            unstaged: [],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        if (cmd === "file_diff") return Promise.resolve(emptyDiff);
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      // The selection stays unstaged-sourced (no silent retarget), so the
      // reconcile fetches the now-empty unstaged diff rather than the staged one.
      await vi.waitFor(() => expect(useRepo.getState().fileDiff).toEqual(emptyDiff));
      expect(invokeMock).toHaveBeenCalledWith("file_diff", expect.objectContaining({ staged: false }));
      expect(useRepo.getState().selectedFile).toEqual({ path: "src/a.ts", source: "unstaged" });
    });

    it("publishes only the latest staged or unstaged selection for the same path", async () => {
      const slowUnstaged = deferred<ReturnType<typeof diff>>();
      const staged = diff({ add: 7 });
      let calls = 0;
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "file_diff") {
          return ++calls === 1 ? slowUnstaged.promise : Promise.resolve(staged);
        }
        return defaultInvoke(cmd);
      });

      const oldSelection = useRepo.getState().selectFile("src/a.ts", "unstaged");
      await useRepo.getState().selectFile("src/a.ts", "staged");
      slowUnstaged.resolve(diff({ add: 99 }));
      await oldSelection;

      expect(useRepo.getState().selectedFile).toEqual({ path: "src/a.ts", source: "staged" });
      expect(useRepo.getState().fileDiff).toEqual(staged);
      expect(useRepo.getState().diffLoading).toBe(false);
    });

    it("publishes only the latest full diff when the same path changes bucket", async () => {
      const slowUnstaged = deferred<ReturnType<typeof diff>>();
      const staged = diff({ add: 8 });
      useRepo.setState({
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: diff({ truncated: true }),
      });
      let calls = 0;
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "file_diff") {
          return ++calls === 1 ? slowUnstaged.promise : Promise.resolve(staged);
        }
        return defaultInvoke(cmd);
      });

      const oldFull = useRepo.getState().loadFullFileDiff();
      useRepo.setState({ selectedFile: { path: "src/a.ts", source: "staged" } });
      await useRepo.getState().loadFullFileDiff();
      slowUnstaged.resolve(diff({ add: 99 }));
      await oldFull;

      expect(useRepo.getState().selectedFile).toEqual({ path: "src/a.ts", source: "staged" });
      expect(useRepo.getState().fileDiff).toEqual(staged);
      expect(useRepo.getState().diffLoading).toBe(false);
    });
  });

  it("ignores a stale load-more result after a newer full refresh", async () => {
    const slowLoadMore = deferred<typeof emptyGraph>();
    const refreshedGraph = { ...emptyGraph, head: "fresh" };
    let graphCalls = 0;
    useRepo.setState({
      graph: { ...emptyGraph, truncated: true },
      selectedCommit: null,
      selectedCommits: [],
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "commit_graph") {
        graphCalls += 1;
        return graphCalls === 1 ? slowLoadMore.promise : Promise.resolve(refreshedGraph);
      }
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return defaultInvoke(cmd);
    });

    const loadMore = useRepo.getState().loadMoreHistory();
    await useRepo.getState().refresh({ prs: false, quiet: true });
    slowLoadMore.resolve({ ...emptyGraph, head: "stale" });
    await loadMore;

    // commitGraph returns a validated copy (GL-57), so compare by value.
    expect(useRepo.getState().graph).toEqual(refreshedGraph);
    expect(useRepo.getState().graphLimit).toBe(2_000);
    expect(useRepo.getState().loadingMoreHistory).toBe(false);
  });

  it("ignores a load-more result after switching repositories", async () => {
    const slowLoadMore = deferred<typeof emptyGraph>();
    useRepo.setState({ graph: { ...emptyGraph, truncated: true } });
    invokeMock.mockReturnValueOnce(slowLoadMore.promise);

    const loadMore = useRepo.getState().loadMoreHistory();
    useRepo.setState({
      summary: { ...summary, path: "/other" },
      graph: { ...emptyGraph, head: "other" },
      loadingMoreHistory: false,
    });
    slowLoadMore.resolve({ ...emptyGraph, head: "stale" });
    await loadMore;

    expect(useRepo.getState().graph?.head).toBe("other");
  });

  it("clears the active repo state if switching after close cannot load", async () => {
    useRepo.setState({
      summary,
      openPaths: ["/repo", "/other"],
      graph: emptyGraph,
    });
    // Target the neighbour's open specifically: closeRepo now also fires a
    // fire-and-forget unwatch, so a bare `…Once` would be consumed by that.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "open_repo"
        ? Promise.reject(new Error("cannot open"))
        : defaultInvoke(cmd),
    );

    await useRepo.getState().closeRepo("/repo");

    expect(useRepo.getState().openPaths).toEqual(["/other"]);
    expect(useRepo.getState().summary).toBeNull();
    expect(useRepo.getState().graph).toBeNull();
    expect(useRepo.getState().graphLimit).toBe(2_000);
    expect(useRepo.getState().error).toContain("cannot open");
  });
});

// The hand-off dialog is repo-bound like confirm/prompt/recovery, so a repo
// switch must clear it — EXCEPT the switch the hand-off itself performs when
// it lands on the destination (flagged via `handoffRunning`), which is about
// to show the success screen (GL-105).

describe("repo store — read request ownership", () => {
  const changed = (path: string): WorkingChanges => ({
    staged: [],
    unstaged: [{ path, status: "M", add: 1, del: 0, binary: false }],
    conflicted: [],
    advanced: emptyAdvancedState,
  });
  const operationNone = { kind: "none", canSkip: false, conflicts: [] };

  it("keeps the newest of two overlapping quiet worktree refreshes", async () => {
    const oldChanges = deferred<WorkingChanges>();
    let calls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "working_changes") {
        calls += 1;
        return calls === 1 ? oldChanges.promise : Promise.resolve(changed("new.ts"));
      }
      if (cmd === "operation_status") return Promise.resolve(operationNone);
      return defaultInvoke(cmd);
    });
    useRepo.setState({ summary, loading: false, error: null, changes: EMPTY_CHANGES });

    const stale = useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
    await expect(
      useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" }),
    ).resolves.toBe(true);
    oldChanges.resolve(changed("old.ts"));

    await expect(stale).resolves.toBe(false);
    expect(useRepo.getState().changes.unstaged[0]?.path).toBe("new.ts");
  });

  it("lets a newer worktree refresh win while an older full refresh still publishes graph metadata", async () => {
    const oldChanges = deferred<WorkingChanges>();
    const freshGraph: RepoGraph = {
      ...emptyGraph,
      commits: [node({ id: "fresh" })],
      head: "fresh",
    };
    const freshBranches: BranchInfo[] = [
      { name: "fresh", kind: "local", target: "fresh", isHead: true, upstream: null, remote: null },
    ];
    let changesCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return Promise.resolve(freshGraph);
      if (cmd === "list_branches") return Promise.resolve(freshBranches);
      if (cmd === "working_changes") {
        changesCalls += 1;
        return changesCalls === 1 ? oldChanges.promise : Promise.resolve(changed("new.ts"));
      }
      if (cmd === "operation_status") return Promise.resolve(operationNone);
      if (cmd === "repo_forge")
        return Promise.resolve({ hasRemote: false, kind: null, forge: null, host: null, webUrl: null });
      return defaultInvoke(cmd);
    });
    useRepo.setState({ summary, graph: emptyGraph, loading: false, changes: EMPTY_CHANGES });

    const full = useRepo.getState().refresh({ quiet: true, prs: false });
    await vi.waitFor(() => expect(changesCalls).toBe(1));
    await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
    oldChanges.resolve(changed("old.ts"));
    await full;

    expect(useRepo.getState().graph).toEqual(freshGraph);
    expect(useRepo.getState().branches).toEqual(freshBranches);
    expect(useRepo.getState().changes.unstaged[0]?.path).toBe("new.ts");
  });

  it("lets a newer full refresh win over an older worktree refresh", async () => {
    const oldChanges = deferred<WorkingChanges>();
    let changesCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      if (cmd === "working_changes") {
        changesCalls += 1;
        return changesCalls === 1 ? oldChanges.promise : Promise.resolve(changed("full.ts"));
      }
      if (cmd === "operation_status") return Promise.resolve(operationNone);
      if (cmd === "repo_forge")
        return Promise.resolve({ hasRemote: false, kind: null, forge: null, host: null, webUrl: null });
      return defaultInvoke(cmd);
    });
    useRepo.setState({ summary, graph: emptyGraph, loading: false, changes: EMPTY_CHANGES });

    const stale = useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
    await useRepo.getState().refresh({ quiet: true, prs: false });
    oldChanges.resolve(changed("old.ts"));

    await expect(stale).resolves.toBe(false);
    expect(useRepo.getState().changes.unstaged[0]?.path).toBe("full.ts");
  });

  it("keeps a load-more graph while the superseded full refresh publishes its independent lanes", async () => {
    const fullGraph = deferred<RepoGraph>();
    const pagedGraph: RepoGraph = { ...emptyGraph, head: "paged", truncated: false };
    const freshBranches: BranchInfo[] = [
      { name: "lane", kind: "local", target: "lane", isHead: true, upstream: null, remote: null },
    ];
    invokeMock.mockImplementation((cmd: string, args: { limit?: number }) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") {
        return args.limit === 4_000 ? Promise.resolve(pagedGraph) : fullGraph.promise;
      }
      if (cmd === "list_branches") return Promise.resolve(freshBranches);
      if (cmd === "working_changes") return Promise.resolve(changed("lane.ts"));
      if (cmd === "operation_status") return Promise.resolve(operationNone);
      if (cmd === "repo_forge")
        return Promise.resolve({ hasRemote: false, kind: null, forge: null, host: null, webUrl: null });
      return defaultInvoke(cmd);
    });
    useRepo.setState({
      summary,
      graph: { ...emptyGraph, truncated: true },
      graphLimit: 2_000,
      loading: false,
      loadingMoreHistory: false,
      branches: [],
      changes: EMPTY_CHANGES,
    });

    const full = useRepo.getState().refresh({ quiet: true, prs: false });
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("commit_graph", { path: "/repo", limit: 2_000 }),
    );
    await useRepo.getState().loadMoreHistory();
    fullGraph.resolve({ ...emptyGraph, head: "stale-full" });
    await full;

    expect(useRepo.getState().graph).toEqual(pagedGraph);
    expect(useRepo.getState().branches).toEqual(freshBranches);
    expect(useRepo.getState().changes.unstaged[0]?.path).toBe("lane.ts");
  });

  it("publishes successful secondary lanes when the current graph read rejects", async () => {
    const oldGraph: RepoGraph = { ...emptyGraph, head: "old" };
    const freshBranches: BranchInfo[] = [
      { name: "fresh", kind: "local", target: "fresh", isHead: true, upstream: null, remote: null },
    ];
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return Promise.reject(new Error("graph failed"));
      if (cmd === "list_branches") return Promise.resolve(freshBranches);
      if (cmd === "working_changes") return Promise.resolve(changed("fresh.ts"));
      if (cmd === "operation_status") return Promise.resolve(operationNone);
      if (cmd === "repo_forge")
        return Promise.resolve({ hasRemote: false, kind: null, forge: null, host: null, webUrl: null });
      return defaultInvoke(cmd);
    });
    useRepo.setState({ summary, graph: oldGraph, loading: false, error: null, branches: [], changes: EMPTY_CHANGES });

    await expect(useRepo.getState().refresh({ quiet: true, prs: false })).resolves.toBe(false);

    expect(useRepo.getState().graph).toBe(oldGraph);
    expect(useRepo.getState().branches).toEqual(freshBranches);
    expect(useRepo.getState().changes.unstaged[0]?.path).toBe("fresh.ts");
    expect(useRepo.getState().error).toContain("graph failed");
  });

  it("keeps old metadata but publishes graph and worktree when branches reject", async () => {
    const oldBranches: BranchInfo[] = [
      { name: "old", kind: "local", target: "old", isHead: true, upstream: null, remote: null },
    ];
    const freshGraph: RepoGraph = { ...emptyGraph, head: "fresh" };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return Promise.resolve(freshGraph);
      if (cmd === "list_branches") return Promise.reject(new Error("branches failed"));
      if (cmd === "working_changes") return Promise.resolve(changed("fresh.ts"));
      if (cmd === "operation_status") return Promise.resolve(operationNone);
      if (cmd === "repo_forge")
        return Promise.resolve({ hasRemote: false, kind: null, forge: null, host: null, webUrl: null });
      return defaultInvoke(cmd);
    });
    useRepo.setState({ summary, graph: emptyGraph, loading: false, error: null, branches: oldBranches, changes: EMPTY_CHANGES });

    await expect(useRepo.getState().refresh({ quiet: true, prs: false })).resolves.toBe(false);

    expect(useRepo.getState().graph).toEqual(freshGraph);
    expect(useRepo.getState().branches).toBe(oldBranches);
    expect(useRepo.getState().changes.unstaged[0]?.path).toBe("fresh.ts");
    expect(useRepo.getState().error).toContain("branches failed");
  });

  it("keeps only the newest reflog completion and error state", async () => {
    const stale = deferred<never[]>();
    let calls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_reflog") {
        calls += 1;
        return calls === 1 ? stale.promise : Promise.resolve([]);
      }
      return defaultInvoke(cmd);
    });
    useRepo.setState({ summary, reflogEntries: [], reflogLoading: false, reflogError: "old" });

    const oldLoad = useRepo.getState().loadReflog();
    await useRepo.getState().loadReflog();
    stale.reject(new Error("stale reflog error"));
    await oldLoad;

    expect(useRepo.getState().reflogEntries).toEqual([]);
    expect(useRepo.getState().reflogLoading).toBe(false);
    expect(useRepo.getState().reflogError).toBeNull();
  });

  it("suppresses old same-path load secondary results after a reopen", async () => {
    const oldBranches = deferred<BranchInfo[]>();
    const oldChanges = deferred<WorkingChanges>();
    const freshBranches: BranchInfo[] = [
      { name: "fresh", kind: "local", target: "fresh", isHead: true, upstream: null, remote: null },
    ];
    let branchCalls = 0;
    let changesCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      if (cmd === "list_branches") {
        branchCalls += 1;
        return branchCalls === 1 ? oldBranches.promise : Promise.resolve(freshBranches);
      }
      if (cmd === "working_changes") {
        changesCalls += 1;
        return changesCalls === 1 ? oldChanges.promise : Promise.resolve(changed("fresh.ts"));
      }
      if (cmd === "operation_status") return Promise.resolve(operationNone);
      if (cmd === "repo_forge")
        return Promise.resolve({ hasRemote: false, kind: null, forge: null, host: null, webUrl: null });
      return defaultInvoke(cmd);
    });
    useRepo.setState({ summary, openPaths: ["/repo"], loading: false, branches: [], changes: EMPTY_CHANGES });

    await useRepo.getState().loadRepo("/repo");
    await useRepo.getState().loadRepo("/repo");
    oldBranches.resolve([
      { name: "stale", kind: "local", target: "stale", isHead: true, upstream: null, remote: null },
    ]);
    oldChanges.resolve(changed("stale.ts"));
    await Promise.resolve();

    expect(useRepo.getState().branches).toEqual(freshBranches);
    expect(useRepo.getState().changes.unstaged[0]?.path).toBe("fresh.ts");
  });

  it("prefetches PRs once the winning forge and superseding manual remotes are both ready", async () => {
    const forge = deferred<RepoForge>();
    const staleRemotes = deferred<never[]>();
    const remote = {
      name: "origin",
      fetchUrl: "https://github.com/o/r.git",
      pushUrl: "https://github.com/o/r.git",
      isDefault: true,
    };
    let remoteCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      if (cmd === "working_changes") return Promise.resolve(EMPTY_CHANGES);
      if (cmd === "operation_status") return Promise.resolve(operationNone);
      if (cmd === "repo_forge") return forge.promise;
      if (cmd === "list_remotes") {
        remoteCalls += 1;
        return remoteCalls === 1 ? staleRemotes.promise : Promise.resolve([remote]);
      }
      return defaultInvoke(cmd);
    });
    const realLoadPullRequests = usePulls.getState().loadPullRequests;
    const loadPullRequests = vi.fn().mockResolvedValue(undefined);
    usePulls.setState({ loadPullRequests });
    useRepo.setState({ summary, openPaths: ["/repo"], loading: false, remotes: [] });

    try {
      await useRepo.getState().loadRepo("/repo");
      await useRepo.getState().listRemotes();
      staleRemotes.resolve([]);
      forge.resolve({
        hasRemote: true,
        kind: ForgeKind.GitHub,
        forge: "GitHub",
        host: "github.com",
        webUrl: "https://github.com/o/r",
      });
      await vi.waitFor(() => expect(loadPullRequests).toHaveBeenCalledTimes(1));
    } finally {
      usePulls.setState({ loadPullRequests: realLoadPullRequests });
    }
  });

  it("invalidates a foreground selection missing from the refreshed graph and loads the fallback", async () => {
    const probe = deferred<RepoSummary>();
    const staleBFiles = deferred<unknown[]>();
    const graphA: RepoGraph = {
      ...emptyGraph,
      commits: [node({ id: "a" })],
      head: "a",
    };
    const filesA = [{ path: "a.ts", status: "M", add: 1, del: 0, binary: false }];
    let openCalls = 0;
    invokeMock.mockImplementation((cmd: string, args: { oid?: string }) => {
      if (cmd === "open_repo") {
        openCalls += 1;
        return openCalls === 1 ? Promise.resolve(summary) : probe.promise;
      }
      if (cmd === "commit_graph") return Promise.resolve(graphA);
      if (cmd === "list_branches") return Promise.resolve([]);
      if (cmd === "working_changes") return Promise.reject(new Error("status failed"));
      if (cmd === "operation_status") return Promise.resolve(operationNone);
      if (cmd === "repo_forge")
        return Promise.resolve({ hasRemote: false, kind: null, forge: null, host: null, webUrl: null });
      if (cmd === "commit_files") return args.oid === "b" ? staleBFiles.promise : Promise.resolve(filesA);
      return defaultInvoke(cmd);
    });
    useRepo.setState({
      summary,
      graph: { ...emptyGraph, commits: [node({ id: "b" })], head: "b" },
      selectedCommit: "b",
      selectedCommits: ["b"],
      selectionAnchor: "b",
      commitFiles: [],
      loading: false,
      error: null,
    });

    const full = useRepo.getState().refresh({ quiet: true, prs: false });
    await vi.waitFor(() => expect(openCalls).toBe(2));
    const staleSelection = useRepo.getState().selectCommitMulti("b", {});
    probe.resolve(summary);
    await full;
    staleBFiles.resolve([{ path: "b.ts", status: "M", add: 9, del: 0, binary: false }]);
    await staleSelection;
    await vi.waitFor(() => expect(useRepo.getState().commitFiles).toEqual(filesA));

    expect(useRepo.getState().selectedCommit).toBe("a");
    expect(useRepo.getState().selectedCommits).toEqual(["a"]);
    expect(useRepo.getState().diffLoading).toBe(false);
  });
});
