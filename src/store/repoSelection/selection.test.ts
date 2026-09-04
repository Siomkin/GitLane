// Selecting a working file and reconciling the merged commit/working selection.
//
// Split out of the former src/store/repo.test.ts, which reached 5 122 lines;
// shared data fixtures live in @/test/repoFixtures.

import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { WIP_SELECTION_ID } from "@/store/selection";
import { reconcileWorkingUnion } from "@/store/repoSelectionDiff";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the IPC boundary so the store's async actions run headlessly. `vi.mock`
// is hoisted above the import below; `vi.hoisted` makes `invokeMock` exist in time.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRepo } from "@/store/repo";
import { defaultInvoke, deferred, emptyGraph, node, summary } from "@/test/repoFixtures";
import type {
  RepoGraph,
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

describe("repo store — ensureWorkingFileSelection", () => {
  const change = (path: string) => ({
    path,
    status: "M" as const,
    add: 1,
    del: 0,
    binary: false,
  });
  const diff = (path: string) => ({
    ...change(path),
    hunks: [],
    truncated: false,
  });

  it("selects the first live working file when no working selection exists", async () => {
    useRepo.setState({
      changes: {
        staged: [change("staged.ts")],
        unstaged: [change("unstaged.ts")],
        conflicted: [],
        advanced: emptyAdvancedState,
      },
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "file_diff" ? Promise.resolve(diff("unstaged.ts")) : defaultInvoke(cmd),
    );

    useRepo.getState().ensureWorkingFileSelection();

    await vi.waitFor(() =>
      expect(useRepo.getState().selectedFile).toEqual({ path: "unstaged.ts", source: "unstaged" }),
    );
    expect(invokeMock).toHaveBeenCalledWith("file_diff", {
      path: "/repo",
      file: "unstaged.ts",
      staged: false,
      full: null,
    });
  });

  it("keeps the path but changes source when staging moves the selected file", async () => {
    useRepo.setState({
      changes: {
        staged: [change("src/a.ts")],
        unstaged: [],
        conflicted: [],
        advanced: emptyAdvancedState,
      },
      selectedFile: { path: "src/a.ts", source: "unstaged" },
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "file_diff" ? Promise.resolve(diff("src/a.ts")) : defaultInvoke(cmd),
    );

    useRepo.getState().ensureWorkingFileSelection();

    await vi.waitFor(() =>
      expect(useRepo.getState().selectedFile).toEqual({ path: "src/a.ts", source: "staged" }),
    );
    expect(invokeMock).toHaveBeenCalledWith("file_diff", {
      path: "/repo",
      file: "src/a.ts",
      staged: true,
      full: null,
    });
  });

  it("does not reload a selection that is still in its owning bucket", () => {
    useRepo.setState({
      changes: {
        staged: [],
        unstaged: [change("src/a.ts")],
        conflicted: [],
        advanced: emptyAdvancedState,
      },
      selectedFile: { path: "src/a.ts", source: "unstaged" },
    });

    useRepo.getState().ensureWorkingFileSelection();

    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("repo store — merged selection (GL-69)", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("re-fetches the union when a refresh trims the multi-selection", async () => {
    // Start with a 3-commit union; the refresh's graph drops commit "c".
    useRepo.setState({
      selectedCommit: "a",
      selectedCommits: ["a", "b", "c"],
      selectionDiff: {
        commits: ["a", "b", "c"],
        files: [{ path: "stale.ts", status: "M", add: 1, del: 0, binary: false }],
        loading: false,
        error: null,
      },
    });
    const trimmedGraph: RepoGraph = {
      ...emptyGraph,
      commits: [node({ id: "a", shortId: "a" }), node({ id: "b", shortId: "b" })],
      head: "a",
    };
    const freshFiles = [{ path: "fresh.ts", status: "A", add: 2, del: 0, binary: false }];
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(trimmedGraph);
        case "working_changes":
          return Promise.resolve({ staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState });
        case "selection_diff":
          return Promise.resolve(freshFiles);
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().refresh({ prs: false, quiet: true });
    await flush(); // the union re-fetch is fire-and-forget

    const diff = useRepo.getState().selectionDiff!;
    expect(useRepo.getState().selectedCommits).toEqual(["a", "b"]);
    expect(diff.commits).toEqual(["a", "b"]);
    expect(diff.files).toEqual(freshFiles);
    expect(diff.loading).toBe(false);
    // The union was reloaded for the trimmed set, not the stale [a,b,c].
    expect(invokeMock).toHaveBeenCalledWith("selection_diff", { path: "/repo", oids: ["a", "b"] });
  });

  it("retries the union on refresh when the cached one had an error", async () => {
    // A transient selection_diff failure must not survive ordinary re-syncs.
    useRepo.setState({
      selectedCommit: "a",
      selectedCommits: ["a", "b"],
      selectionDiff: { commits: ["a", "b"], files: [], loading: false, error: "boom" },
    });
    const graph: RepoGraph = {
      ...emptyGraph,
      commits: [node({ id: "a", shortId: "a" }), node({ id: "b", shortId: "b" })],
      head: "a",
    };
    const freshFiles = [{ path: "ok.ts", status: "M", add: 1, del: 0, binary: false }];
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(graph);
        case "working_changes":
          return Promise.resolve({ staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState });
        case "selection_diff":
          return Promise.resolve(freshFiles);
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().refresh({ prs: false, quiet: true });
    await flush();

    const diff = useRepo.getState().selectionDiff!;
    expect(diff.error).toBeNull(); // the stale error was cleared
    expect(diff.files).toEqual(freshFiles); // and the union retried successfully
    expect(invokeMock).toHaveBeenCalledWith("selection_diff", { path: "/repo", oids: ["a", "b"] });
  });

  it("drops selectionDiff when a refresh collapses the selection to one commit", async () => {
    useRepo.setState({
      selectedCommit: "a",
      selectedCommits: ["a", "b"],
      selectionDiff: { commits: ["a", "b"], files: [], loading: false, error: null },
    });
    const oneLeft: RepoGraph = { ...emptyGraph, commits: [node({ id: "a", shortId: "a" })], head: "a" };
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "open_repo"
        ? Promise.resolve(summary)
        : cmd === "commit_graph"
          ? Promise.resolve(oneLeft)
          : cmd === "working_changes"
            ? Promise.resolve({ staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState })
            : defaultInvoke(cmd),
    );

    await useRepo.getState().refresh({ prs: false, quiet: true });
    await flush();

    expect(useRepo.getState().selectedCommits).toEqual(["a"]);
    expect(useRepo.getState().selectionDiff).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("selection_diff", expect.anything());
  });

  it("folds the uncommitted changes into the union when the WIP row joins the pick", async () => {
    // Commits + WIP is a range ending at the working tree: one compare_refs from
    // the oldest pick's parent, not a committed-only selection_diff.
    const graph: RepoGraph = {
      ...emptyGraph,
      commits: [node({ id: "a", shortId: "a", parents: ["p"] })],
      head: "a",
    };
    const dirty = { path: "live.ts", status: "M" as const, add: 3, del: 1, binary: false };
    useRepo.setState({
      summary,
      graph,
      selectedCommit: null,
      selectedCommits: [],
      selectionAnchor: null,
      selectionDiff: null,
      wipSelected: false,
      changes: { staged: [], unstaged: [dirty], conflicted: [], advanced: emptyAdvancedState },
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "compare_refs"
        ? Promise.resolve({ files: [dirty], add: 3, del: 1, ahead: 0, behind: 0 })
        : defaultInvoke(cmd),
    );

    await useRepo.getState().selectCommitMulti("a", {});
    await useRepo.getState().selectCommitMulti(WIP_SELECTION_ID, { additive: true });

    const state = useRepo.getState();
    expect(state.wipSelected).toBe(true);
    expect(state.selectedCommits).toEqual(["a"]); // the sentinel never leaks out
    expect(state.selectionDiff!.workingBase).toBe("p");
    expect(state.selectionDiff!.files).toEqual([dirty]);
    expect(invokeMock).toHaveBeenCalledWith(
      "compare_refs",
      expect.objectContaining({ base: "p", head: null }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("selection_diff", expect.anything());
  });

  it("leaves the WIP row out when the pick does not reach HEAD", async () => {
    // b+c is contiguous, but a (HEAD) sits above it: base(c)..working tree would
    // silently include a plus the uncommitted work, so WIP must not join.
    const graph: RepoGraph = {
      ...emptyGraph,
      commits: [
        node({ id: "a", shortId: "a", parents: ["b"] }),
        node({ id: "b", shortId: "b", parents: ["c"] }),
        node({ id: "c", shortId: "c", parents: ["p"] }),
      ],
      head: "a",
    };
    const dirty = { path: "live.ts", status: "M" as const, add: 1, del: 0, binary: false };
    useRepo.setState({
      summary,
      graph,
      selectedCommit: null,
      selectedCommits: [],
      selectionAnchor: null,
      selectionDiff: null,
      wipSelected: false,
      changes: { staged: [], unstaged: [dirty], conflicted: [], advanced: emptyAdvancedState },
    });
    invokeMock.mockImplementation((cmd: string) => defaultInvoke(cmd));

    await useRepo.getState().selectCommitMulti("b", {});
    await useRepo.getState().selectCommitMulti("c", { additive: true });
    await useRepo.getState().selectCommitMulti(WIP_SELECTION_ID, { additive: true });

    const state = useRepo.getState();
    expect(state.wipSelected).toBe(false);
    expect(state.selectedCommits).toEqual(["b", "c"]);
    expect(state.selectionDiff?.workingBase ?? null).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("compare_refs", expect.anything());
  });

  it("accepts a gapped pick that reaches HEAD and spans the commits between", async () => {
    // The real case: the checked-out tip plus an older commit on the same branch.
    // A range can't skip b, so it is part of the diff — base is c's parent.
    const graph: RepoGraph = {
      ...emptyGraph,
      commits: [
        node({ id: "a", shortId: "a", parents: ["b"] }),
        node({ id: "b", shortId: "b", parents: ["c"] }),
        node({ id: "c", shortId: "c", parents: ["p"] }),
      ],
      head: "a",
    };
    const dirty = { path: "live.ts", status: "M" as const, add: 1, del: 0, binary: false };
    useRepo.setState({
      summary,
      graph,
      selectedCommit: null,
      selectedCommits: [],
      selectionAnchor: null,
      selectionDiff: null,
      wipSelected: false,
      changes: { staged: [], unstaged: [dirty], conflicted: [], advanced: emptyAdvancedState },
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "compare_refs"
        ? Promise.resolve({ files: [dirty], add: 1, del: 0, ahead: 0, behind: 0 })
        : defaultInvoke(cmd),
    );

    await useRepo.getState().selectCommitMulti("a", {});
    await useRepo.getState().selectCommitMulti("c", { additive: true });
    await useRepo.getState().selectCommitMulti(WIP_SELECTION_ID, { additive: true });

    const state = useRepo.getState();
    expect(state.wipSelected).toBe(true);
    expect(state.selectionDiff?.workingBase).toBe("p");
    expect(invokeMock).toHaveBeenCalledWith(
      "compare_refs",
      expect.objectContaining({ base: "p", head: null }),
    );
  });

  it("drops the WIP anchor once the WIP row leaves the pick", async () => {
    // Shift-extending from WIP anchors on the sentinel; toggling WIP back off
    // must not leave that anchor behind, or the next shift-click would range
    // from it and silently fold the working tree back in.
    const graph: RepoGraph = {
      ...emptyGraph,
      commits: [
        node({ id: "a", shortId: "a", parents: ["b"] }),
        node({ id: "b", shortId: "b", parents: ["p"] }),
      ],
      head: "a",
    };
    const dirty = { path: "live.ts", status: "M" as const, add: 1, del: 0, binary: false };
    useRepo.setState({
      summary,
      graph,
      selectedCommit: null,
      selectedCommits: [],
      selectionAnchor: null,
      selectionDiff: null,
      wipSelected: true,
      changes: { staged: [], unstaged: [dirty], conflicted: [], advanced: emptyAdvancedState },
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "compare_refs"
        ? Promise.resolve({ files: [dirty], add: 1, del: 0, ahead: 0, behind: 0 })
        : defaultInvoke(cmd),
    );

    await useRepo.getState().selectCommitMulti("a", { shift: true }); // extend from WIP
    expect(useRepo.getState().selectionAnchor).toBe(WIP_SELECTION_ID);

    await useRepo.getState().selectCommitMulti(WIP_SELECTION_ID, { additive: true }); // WIP off

    expect(useRepo.getState().wipSelected).toBe(false);
    expect(useRepo.getState().selectionAnchor).toBeNull();
  });

  it("clears the WIP row along with the selection after a batch operation", async () => {
    useRepo.setState({
      selectedCommits: ["a"],
      selectionAnchor: "a",
      wipSelected: true,
      selectionDiff: { commits: ["a"], files: [], workingBase: "p", loading: false, error: null },
    });

    useRepo.getState().clearSelection();

    expect(useRepo.getState().wipSelected).toBe(false);
    expect(useRepo.getState().selectionDiff).toBeNull();
  });

  it("folds a working union back to the commit's own files once the tree is clean", async () => {
    // Committing from a one-commit + WIP pick clears wipSelected; the union has
    // no uncommitted part left, so it must drop rather than strand the inspector.
    const files = [{ path: "a.ts", status: "M" as const, add: 1, del: 0, binary: false }];
    useRepo.setState({
      summary,
      selectedCommit: "a",
      selectedCommits: ["a"],
      wipSelected: false,
      commitFiles: [],
      selectionDiff: { commits: ["a"], files: [], workingBase: "p", loading: false, error: null },
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "commit_files" ? Promise.resolve(files) : defaultInvoke(cmd),
    );

    reconcileWorkingUnion(useRepo.setState, useRepo.getState, "/repo");
    await vi.waitFor(() => expect(useRepo.getState().commitFiles).toEqual(files));

    expect(useRepo.getState().selectionDiff).toBeNull();
    expect(useRepo.getState().diffLoading).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith("compare_refs", expect.anything());
  });

  it("still publishes the union if a refresh reorders the same selection mid-fetch", async () => {
    // The stuck-loading regression: a background refresh re-publishes the same
    // commit *set* in a different order while the union fetch is in flight. The
    // resolved fetch must still publish (set-based guard), not bail on order.
    const graph: RepoGraph = {
      ...emptyGraph,
      commits: [node({ id: "a", shortId: "a" }), node({ id: "b", shortId: "b" })],
      head: "a",
    };
    useRepo.setState({ graph, selectedCommit: null, selectedCommits: [], selectionAnchor: null, selectionDiff: null });
    const slow = deferred<unknown>();
    const files = [{ path: "u.ts", status: "M", add: 1, del: 0, binary: false }];
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "selection_diff" ? slow.promise : defaultInvoke(cmd),
    );

    await useRepo.getState().selectCommitMulti("a", {}); // single
    const pending = useRepo.getState().selectCommitMulti("b", { additive: true }); // [a,b] — union in flight
    // A refresh re-publishes the same set reordered (focus-first), no re-fetch.
    useRepo.setState({
      selectedCommits: ["b", "a"],
      selectionDiff: { commits: ["b", "a"], files: [], loading: true, error: null },
    });
    slow.resolve(files);
    await pending;

    const diff = useRepo.getState().selectionDiff!;
    expect(diff.loading).toBe(false); // not stuck
    expect(diff.files).toEqual(files); // published despite the reorder
  });

  it("publishes only the latest union when selections change rapidly", async () => {
    const graph: RepoGraph = {
      ...emptyGraph,
      commits: [node({ id: "a", shortId: "a" }), node({ id: "b", shortId: "b" }), node({ id: "c", shortId: "c" })],
      head: "a",
    };
    useRepo.setState({ graph, selectedCommit: null, selectedCommits: [], selectionAnchor: null, selectionDiff: null });

    const slow = deferred<unknown>();
    const filesAB = [{ path: "ab.ts", status: "M", add: 1, del: 0, binary: false }];
    const filesABC = [{ path: "abc.ts", status: "A", add: 2, del: 0, binary: false }];
    let selectionCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "selection_diff") {
        selectionCalls += 1;
        // First union ([a,b]) is slow; the second ([a,b,c]) resolves immediately.
        return selectionCalls === 1 ? slow.promise : Promise.resolve(filesABC);
      }
      return defaultInvoke(cmd);
    });

    await useRepo.getState().selectCommitMulti("a", {}); // single
    const pending = useRepo.getState().selectCommitMulti("b", { additive: true }); // [a,b] — slow union
    await useRepo.getState().selectCommitMulti("c", { additive: true }); // [a,b,c] — fast union publishes
    slow.resolve(filesAB); // the stale [a,b] union lands late
    await pending;

    const diff = useRepo.getState().selectionDiff!;
    expect(diff.commits).toEqual(["a", "b", "c"]);
    expect(diff.files).toEqual(filesABC); // the stale [a,b] result was discarded
  });

  it("publishes only the newest union across an A-B-away-A-B cycle", async () => {
    const graph: RepoGraph = {
      ...emptyGraph,
      commits: [node({ id: "a" }), node({ id: "b" }), node({ id: "c" })],
      head: "a",
    };
    useRepo.setState({ graph, selectedCommit: null, selectedCommits: [], selectionAnchor: null, selectionDiff: null });
    const oldUnion = deferred<unknown>();
    const oldFiles = [{ path: "old.ts", status: "M", add: 1, del: 0, binary: false }];
    const newFiles = [{ path: "new.ts", status: "A", add: 2, del: 0, binary: false }];
    let calls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "selection_diff") {
        calls += 1;
        return calls === 1 ? oldUnion.promise : Promise.resolve(newFiles);
      }
      return defaultInvoke(cmd);
    });

    await useRepo.getState().selectCommitMulti("a", {});
    const stale = useRepo.getState().selectCommitMulti("b", { additive: true });
    await useRepo.getState().selectCommitMulti("c", {});
    await useRepo.getState().selectCommitMulti("a", {});
    await useRepo.getState().selectCommitMulti("b", { additive: true });
    oldUnion.resolve(oldFiles);
    await stale;

    expect(useRepo.getState().selectionDiff?.commits).toEqual(["a", "b"]);
    expect(useRepo.getState().selectionDiff?.files).toEqual(newFiles);
  });

  it("publishes only the newest single-commit files across A-B-A", async () => {
    const graph: RepoGraph = {
      ...emptyGraph,
      commits: [node({ id: "a" }), node({ id: "b" })],
      head: "a",
    };
    const oldA = deferred<unknown[]>();
    const filesB = [{ path: "b.ts", status: "M", add: 1, del: 0, binary: false }];
    const filesA = [{ path: "new-a.ts", status: "M", add: 2, del: 0, binary: false }];
    let aCalls = 0;
    invokeMock.mockImplementation((cmd: string, args: { oid?: string }) => {
      if (cmd !== "commit_files") return defaultInvoke(cmd);
      if (args.oid === "b") return Promise.resolve(filesB);
      aCalls += 1;
      return aCalls === 1 ? oldA.promise : Promise.resolve(filesA);
    });
    useRepo.setState({ graph, selectedCommit: null, selectedCommits: [], selectionAnchor: null, commitFiles: [] });

    const stale = useRepo.getState().selectCommitMulti("a", {});
    await useRepo.getState().selectCommitMulti("b", {});
    await useRepo.getState().selectCommitMulti("a", {});
    oldA.resolve([{ path: "old-a.ts", status: "M", add: 9, del: 0, binary: false }]);
    await stale;

    expect(useRepo.getState().selectedCommit).toBe("a");
    expect(useRepo.getState().commitFiles).toEqual(filesA);
  });

  it("selectFile ignores a stale union diff after the selection set changes", async () => {
    useRepo.setState({
      selectedCommits: ["a", "b"],
      selectionDiff: { commits: ["a", "b"], files: [], loading: false, error: null },
      selectedFile: null,
      fileDiff: null,
    });
    const slow = deferred<unknown>();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "selection_diff_file" ? slow.promise : defaultInvoke(cmd),
    );

    const pending = useRepo.getState().selectFile("x.ts", "commit");
    // A new multi-selection lands (same file path, different commit set) before
    // the in-flight per-file diff resolves.
    useRepo.setState({ selectionDiff: { commits: ["a", "c"], files: [], loading: false, error: null } });
    slow.resolve({ path: "x.ts", status: "M", add: 9, del: 9, binary: false, hunks: [], truncated: false });
    await pending;

    // The stale diff must not publish over the newer selection.
    expect(useRepo.getState().fileDiff).toBeNull();
  });
});
