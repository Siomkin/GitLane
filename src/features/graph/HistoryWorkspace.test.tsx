import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitNode, FileChange, RepoGraph, StashEntry } from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { useRepo } from "@/store/repo";
import { rowHeightFor, useUi, actionMenuOf, commitMenuOf, stashMenuOf } from "@/store/ui";
import { HistoryWorkspace } from "./HistoryWorkspace";
import { ColumnHandle } from "./ColumnHandle";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const canvasGetContextDescriptor = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "getContext",
);
const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetHeight",
);
const offsetWidthDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetWidth",
);
const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollHeight",
);
const scrollToDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTo",
);

// The DAG canvas (GraphLayer) calls getContext, which jsdom doesn't implement —
// stub it to null so the painter early-returns instead of throwing in the effect.
beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(() => null),
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return this.getAttribute("data-testid") === "history-scroll" ? 340 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return this.getAttribute("data-testid") === "history-scroll" ? 800 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if (this.getAttribute("data-testid") !== "history-scroll") return 0;
      return Number.parseFloat((this.firstElementChild as HTMLElement | null)?.style.height ?? "0");
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: function scrollTo(options?: ScrollToOptions | number, y?: number) {
      this.scrollTop =
        typeof options === "number" ? (y ?? 0) : (options?.top ?? this.scrollTop);
      this.dispatchEvent(new Event("scroll"));
      this.dispatchEvent(new Event("scrollend"));
    },
  });
});

afterAll(() => {
  for (const [prototype, property, descriptor] of [
    [HTMLCanvasElement.prototype, "getContext", canvasGetContextDescriptor],
    [HTMLElement.prototype, "offsetHeight", offsetHeightDescriptor],
    [HTMLElement.prototype, "offsetWidth", offsetWidthDescriptor],
    [HTMLElement.prototype, "scrollHeight", scrollHeightDescriptor],
    [HTMLElement.prototype, "scrollTo", scrollToDescriptor],
  ] as const) {
    if (descriptor) {
      Object.defineProperty(prototype, property, descriptor);
    } else {
      Reflect.deleteProperty(prototype, property);
    }
  }
});

const commit = (over: Partial<CommitNode>): CommitNode => ({
  id: "c1",
  shortId: "c1",
  summary: "",
  body: "",
  authorName: "",
  authorEmail: "",
  timestamp: 0,
  parents: [],
  lane: 0,
  row: 0,
  refs: [],
  ...over,
});
const c1 = commit({ id: "c1", shortId: "c1", summary: "alpha fix", row: 0 });
const c2 = commit({ id: "c2", shortId: "c2", summary: "beta feature", row: 1, parents: ["c1"] });
const c3 = commit({ id: "c3", shortId: "c3", summary: "gamma chore", row: 2, parents: ["c2"] });
const graph: RepoGraph = { commits: [c1, c2, c3], edges: [], laneCount: 1, wipLane: null, head: "c3", truncated: false };
const file: FileChange = { path: "a.ts", status: "M", add: 1, del: 0, binary: false };
const stash: StashEntry = { index: 0, message: "my stash", oid: "s1", timestamp: 0, baseOid: "c2", baseTimestamp: 0, context: [] };
const compactRowHeight = rowHeightFor("Compact");

// A matched summary is split across <mark> highlight nodes, so match on full
// textContent and pick the innermost element, then climb to the row (role=button).
// Scoped to the graph's scroll container: while a query is active the search
// bar's results panel repeats the same summary text above the rows.
const deepestWithText = (text: string) => {
  const all = within(screen.getByTestId("history-scroll")).getAllByText(
    (_, node) => node?.textContent?.trim() === text,
  );
  return all.find((el) => !all.some((o) => o !== el && el.contains(o)))!;
};
const rowFor = (msg: string) => deepestWithText(msg).closest('[role="button"]')!;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  useRepo.setState({
    summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c3", detached: false },
    graph,
    graphLoading: false,
    changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
    stashes: [],
    commitFiles: [],
    selectedFile: null,
    fileDiff: null,
    selectedCommit: null,
    selectedCommits: [],
    wipSelected: false,
  });
  useUi.setState({
    histQuery: "",
    histFilter: "all",
    histSearchOpen: false,
    histFilterOpen: false,
    graphWidthsByRepo: {},
    density: "Compact",
    draggingFrom: null,
    menu: null,
    stackedReview: null,
  });
});

describe("HistoryWorkspace — graph density", () => {
  it("re-measures row heights when density changes without a remount", () => {
    useUi.setState({ density: "Comfortable" });
    render(<HistoryWorkspace />);
    const rowHeight = () => (rowFor("alpha fix") as HTMLElement).style.height;
    expect(rowHeight()).toBe(`${rowHeightFor("Comfortable")}px`);

    // Without resetting the virtualizer's measurement cache, the rows keep the
    // Comfortable height until a remount even though `rowHeight` changed.
    act(() => useUi.setState({ density: "Compact" }));
    expect(rowHeight()).toBe(`${rowHeightFor("Compact")}px`);
  });
});

describe("HistoryWorkspace — repo-scoped graph width", () => {
  it("stores graph column width by repo path and restores it on repo switch", () => {
    const { rerender } = render(<HistoryWorkspace />);
    const handle = screen.getByTitle("Drag to resize the graph column");
    const startLeft = Number.parseFloat(handle.style.left);

    fireEvent.mouseDown(handle, { clientX: startLeft });
    fireEvent.mouseMove(window, { clientX: 300 });
    fireEvent.mouseUp(window);

    expect(useUi.getState().graphWidthsByRepo["/r"]).toBe(300);

    useRepo.setState({
      summary: { path: "/other", workdir: "/other", headBranch: "main", headOid: "c3", detached: false },
    });
    rerender(<HistoryWorkspace />);
    expect(screen.getByTitle("Drag to resize the graph column").style.left).not.toBe("300px");

    useRepo.setState({
      summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c3", detached: false },
    });
    rerender(<HistoryWorkspace />);
    expect(screen.getByTitle("Drag to resize the graph column").style.left).toBe("300px");
  });

  it("keeps width clamping when storing repo-scoped graph widths", () => {
    useUi.getState().setRepoGraphWidth("/r", 12);
    useUi.getState().setRepoGraphWidth("/other", 900);

    expect(useUi.getState().graphWidthsByRepo).toMatchObject({
      "/r": 48,
      "/other": 640,
    });
  });
});

describe("HistoryWorkspace — search highlight/dim", () => {
  it("renders every commit at full strength when no search is active", () => {
    render(<HistoryWorkspace />);
    expect(screen.getByText("3 commits")).toBeInTheDocument();
    for (const msg of ["alpha fix", "beta feature", "gamma chore"]) {
      expect(rowFor(msg).className).not.toMatch(/opacity-25/);
    }
  });

  it("keeps non-matching commits visible but dims them, leaving matches solid", () => {
    useUi.setState({ histSearchOpen: true, histQuery: "beta" });
    render(<HistoryWorkspace />);
    // All three rows are still in the DOM — search highlights, never filters out.
    expect(screen.getByText("alpha fix")).toBeInTheDocument();
    expect(screen.getByText("gamma chore")).toBeInTheDocument();
    expect(screen.getByText("1 match")).toBeInTheDocument();
    expect(rowFor("beta feature").className).not.toMatch(/opacity-25/);
    expect(rowFor("alpha fix").className).toMatch(/opacity-25/);
    expect(rowFor("gamma chore").className).toMatch(/opacity-25/);
  });

  it("marks the matched substring inside a matching commit (3+ char query)", () => {
    useUi.setState({ histSearchOpen: true, histQuery: "beta" });
    render(<HistoryWorkspace />);
    const marks = Array.from(rowFor("beta feature").querySelectorAll("mark")).map((m) => m.textContent);
    expect(marks).toEqual(["beta"]);
  });

  it("dims but does not mark when the query is under 3 chars", () => {
    useUi.setState({ histSearchOpen: true, histQuery: "be" });
    const { container } = render(<HistoryWorkspace />);
    expect(container.querySelectorAll("mark")).toHaveLength(0); // no substring highlight yet
    expect(rowFor("alpha fix").className).toMatch(/opacity-25/); // …but dimming is already on
  });

  it("keeps a selected non-matching commit at full strength", () => {
    useRepo.setState({ selectedCommit: "c1", selectedCommits: ["c1"] });
    useUi.setState({ histSearchOpen: true, histQuery: "beta" });
    render(<HistoryWorkspace />);
    expect(rowFor("alpha fix").className).not.toMatch(/opacity-25/);
    expect(rowFor("gamma chore").className).toMatch(/opacity-25/);
  });

  it("dims the synthetic WIP and stash rows while searching, but not when inert", () => {
    useRepo.setState({ changes: { staged: [file], unstaged: [], conflicted: [], advanced: emptyAdvancedState }, stashes: [stash] });
    // Inert: WIP + stash render at full strength.
    const { unmount } = render(<HistoryWorkspace />);
    expect(screen.getByText("WIP").closest("button")!.className).not.toMatch(/opacity-25/);
    expect(screen.getByText("my stash").closest("button")!.className).not.toMatch(/opacity-25/);
    unmount();
    // Searching: neither is a commit match, so both fade with the rest.
    useUi.setState({ histSearchOpen: true, histQuery: "beta" });
    render(<HistoryWorkspace />);
    expect(screen.getByText("WIP").closest("button")!.className).toMatch(/opacity-25/);
    expect(screen.getByText("my stash").closest("button")!.className).toMatch(/opacity-25/);
  });

  it("selects an anchored stash on left click and loads its file list", async () => {
    useRepo.setState({ stashes: [{ ...stash, index: 3, message: "branch stash", oid: "s3" }] });
    invokeMock.mockImplementation((command: string, args: { oid?: string }) =>
      command === "commit_files" && args.oid === "s3" ? Promise.resolve([file]) : Promise.resolve([]),
    );
    render(<HistoryWorkspace />);

    fireEvent.click(screen.getByText("branch stash").closest("button")!);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("commit_files", { path: "/r", oid: "s3" }));
    expect(useRepo.getState().selectedCommit).toBe("s3");
    expect(useRepo.getState().selectedCommits).toEqual(["s3"]);
    expect(useRepo.getState().commitFiles).toEqual([file]);
    expect(stashMenuOf(useUi.getState())).toBeNull();
    expect(useUi.getState().stackedReview).toBeNull();
  });

  it("opens anchored stash actions from the context menu addressed by stash oid", () => {
    useRepo.setState({ stashes: [{ ...stash, index: 3, message: "branch stash", oid: "s3" }] });
    render(<HistoryWorkspace />);

    fireEvent.contextMenu(screen.getByText("branch stash").closest("button")!, {
      clientX: 20,
      clientY: 30,
    });

    expect(stashMenuOf(useUi.getState())).toMatchObject({
      oid: "s3",
      message: "branch stash",
      x: 20,
      y: 30,
    });
    expect(useUi.getState().stackedReview).toBeNull();
  });

  it("renders anchored stashes with an explicit graph marker", () => {
    useRepo.setState({ stashes: [stash] });
    render(<HistoryWorkspace />);

    expect(screen.getByText("my stash")).toBeInTheDocument();
    expect(screen.getByTestId("stash-graph-marker")).toHaveClass("border-dashed");
  });
});

describe("HistoryWorkspace — graph loading skeleton", () => {
  it("renders the history skeleton instead of commits while the graph loads", () => {
    // Mirrors the open flow: summary is committed (shell visible) but the heavy
    // graph payload hasn't landed yet (GL-20).
    useRepo.setState({ graph: null, graphLoading: true });
    render(<HistoryWorkspace />);
    expect(screen.getByLabelText("Loading history")).toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("alpha fix")).not.toBeInTheDocument();
  });

  it("drops the skeleton and paints commits once the graph lands", () => {
    // beforeEach already provides a non-null graph with graphLoading false.
    render(<HistoryWorkspace />);
    expect(screen.queryByLabelText("Loading history")).not.toBeInTheDocument();
    expect(screen.getByText("3 commits")).toBeInTheDocument();
    expect(screen.getByText("alpha fix")).toBeInTheDocument();
  });

  it("signals a load failure instead of reading as an empty repo when the graph fails", () => {
    // commitGraph threw after the summary published: skeleton gone, graph null.
    useRepo.setState({ graph: null, graphLoading: false, error: "fatal: bad object" });
    render(<HistoryWorkspace />);
    // Not "0 commits" (which would look like an empty repository).
    expect(screen.queryByText(/\bcommits\b/)).not.toBeInTheDocument();
    expect(screen.getByText("History unavailable")).toBeInTheDocument();
    expect(screen.getByText("fatal: bad object")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("keeps the failure state after the global error is dismissed", () => {
    // Dismissing the global banner clears `error`, but a settled-but-null graph
    // for an open repo is still a failure — the retry path must survive the
    // dismiss instead of falling through to an empty "0 commits" render (GL-20).
    useRepo.setState({ graph: null, graphLoading: false, error: null });
    render(<HistoryWorkspace />);
    expect(screen.queryByText(/\bcommits\b/)).not.toBeInTheDocument();
    expect(screen.getByText("History unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("HistoryWorkspace — virtualized history", () => {
  it("bounds mounted commit rows and updates the window while scrolling", async () => {
    const commits = Array.from({ length: 10_000 }, (_, row) =>
      commit({
        id: `c${row}`,
        shortId: `c${row}`,
        summary: `commit ${row}`,
        row,
      }),
    );
    useRepo.setState({
      graph: {
        commits,
        edges: [],
        laneCount: 1,
        wipLane: null,
        head: "c0",
        truncated: false,
      },
    });
    useUi.setState({
      draggingFrom: { kind: "local", name: "feature/large-history" },
    });

    const { container } = render(<HistoryWorkspace />);
    expect(screen.getAllByRole("button", { name: /commit \d+/ })).toHaveLength(18);
    expect(screen.queryByText("commit 500")).not.toBeInTheDocument();
    expect(container.querySelector("canvas")?.style.height).toBe("612px");

    const scroller = screen.getByTestId("history-scroll");
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 500 * compactRowHeight,
    });
    fireEvent.scroll(scroller);
    fireEvent(scroller, new Event("scrollend"));

    await waitFor(() => expect(screen.getByText("commit 500")).toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: /commit \d+/ }).length).toBeLessThanOrEqual(26);
    expect(screen.queryByText("commit 0")).not.toBeInTheDocument();
    expect(container.querySelector("canvas")?.style.height).toBe("884px");

    const row = rowFor("commit 500");
    fireEvent.click(row);
    expect(useRepo.getState().selectedCommit).toBe("c500");

    fireEvent.contextMenu(row, { clientX: 40, clientY: 60 });
    expect(commitMenuOf(useUi.getState())).toMatchObject({ sha: "c500", x: 40, y: 60 });

    fireEvent.dragOver(row);
    fireEvent.drop(row, { clientX: 70, clientY: 80 });
    expect(actionMenuOf(useUi.getState())).toMatchObject({
      from: { kind: "local", name: "feature/large-history" },
      to: { kind: "commit", sha: "c500" },
    });
  });

  it("shows explicit incremental loading and requests the next page", async () => {
    useRepo.setState({ graph: { ...graph, truncated: true } });
    invokeMock.mockResolvedValueOnce({ ...graph, truncated: false });
    render(<HistoryWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Load more commits" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("commit_graph", {
        path: "/r",
        limit: 4_000,
      }),
    );
  });

  // GL-23: scrolling near the trailing load-more row should keep paging in older
  // history on its own, so long-history exploration doesn't need a click per page.
  const truncatedHistory = (length: number): RepoGraph => ({
    commits: Array.from({ length }, (_, row) =>
      commit({ id: `c${row}`, shortId: `c${row}`, summary: `commit ${row}`, row }),
    ),
    edges: [],
    laneCount: 1,
    wipLane: null,
    head: "c0",
    truncated: true,
  });
  const scrollNearBottom = (atRow = 400) => {
    const scroller = screen.getByTestId("history-scroll");
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: atRow * compactRowHeight,
    });
    fireEvent.scroll(scroller);
    fireEvent(scroller, new Event("scrollend"));
    return scroller;
  };
  const graphCalls = () =>
    invokeMock.mock.calls.filter(([command]) => command === "commit_graph");

  it("auto-requests the next page when the trailing boundary scrolls into view", async () => {
    useRepo.setState({ graph: truncatedHistory(300), graphLimit: 2_000 });
    invokeMock.mockResolvedValueOnce({ ...truncatedHistory(300), truncated: false });

    render(<HistoryWorkspace />);
    // The top of the window is nowhere near the trailing row — nothing auto-loads.
    expect(invokeMock).not.toHaveBeenCalledWith("commit_graph", expect.anything());

    scrollNearBottom();

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("commit_graph", { path: "/r", limit: 4_000 }),
    );
  });

  it("never dispatches a duplicate page request while one is already in flight", async () => {
    useRepo.setState({ graph: truncatedHistory(300), graphLimit: 2_000 });
    // The first page request hangs so loadingMoreHistory stays true across the
    // repeated near-bottom scrolls below.
    let resolveGraph: (value: RepoGraph) => void = () => {};
    invokeMock.mockImplementation((command: string) =>
      command === "commit_graph"
        ? new Promise<RepoGraph>((resolve) => {
            resolveGraph = resolve;
          })
        : Promise.resolve([]),
    );

    render(<HistoryWorkspace />);
    scrollNearBottom();
    await waitFor(() => expect(useRepo.getState().loadingMoreHistory).toBe(true));

    // Two more near-bottom scrolls while the first request is outstanding.
    scrollNearBottom();
    scrollNearBottom();
    expect(graphCalls()).toHaveLength(1);

    // Settling the in-flight page clears the flag and, since the result is no
    // longer truncated, leaves the single request as the only one dispatched.
    resolveGraph({ ...truncatedHistory(300), truncated: false });
    await waitFor(() => expect(useRepo.getState().loadingMoreHistory).toBe(false));
    expect(graphCalls()).toHaveLength(1);
  });

  it("keeps auto-paging on each near-bottom scroll while history stays truncated", async () => {
    useRepo.setState({ graph: truncatedHistory(300), graphLimit: 2_000 });
    // The first page (limit 4,000) is still truncated, so reaching the new bottom
    // pages again to limit 6,000, where the history finally completes.
    invokeMock.mockImplementation((command: string, args?: { limit?: number }) =>
      command !== "commit_graph"
        ? Promise.resolve([])
        : Promise.resolve(
            args?.limit === 4_000
              ? truncatedHistory(800)
              : { ...truncatedHistory(800), truncated: false },
          ),
    );

    render(<HistoryWorkspace />);
    scrollNearBottom(350);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("commit_graph", { path: "/r", limit: 4_000 }),
    );
    await waitFor(() => expect(useRepo.getState().graph?.commits.length).toBe(800));

    // The window grew to 800 rows, so the old scroll spot is no longer near the
    // end — paging only resumes once the user scrolls to the new bottom.
    scrollNearBottom(850);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("commit_graph", { path: "/r", limit: 6_000 }),
    );
  });

  it("does not auto-page when the graph is not truncated", async () => {
    useRepo.setState({
      graph: { ...truncatedHistory(300), truncated: false },
      graphLimit: 2_000,
    });

    render(<HistoryWorkspace />);
    scrollNearBottom();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(graphCalls()).toHaveLength(0);
  });

  it("does not auto-page while a search filter is active (avoids a confusing jump)", async () => {
    useRepo.setState({ graph: truncatedHistory(300), graphLimit: 2_000 });
    useUi.setState({ histSearchOpen: true, histQuery: "commit 1" });

    render(<HistoryWorkspace />);
    scrollNearBottom();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(graphCalls()).toHaveLength(0);
    // The manual fallback is still offered while filtering.
    expect(screen.getByRole("button", { name: "Load more commits" })).toBeInTheDocument();
  });

  it("does not auto-page when only a kind filter is active (empty query)", async () => {
    // `isFiltering` treats a non-"all" kind filter as filtering even with no
    // query, so the same anti-jump guard applies as for a text search.
    useRepo.setState({ graph: truncatedHistory(300), graphLimit: 2_000 });
    useUi.setState({ histFilterOpen: true, histFilter: "merges", histQuery: "" });

    render(<HistoryWorkspace />);
    scrollNearBottom();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(graphCalls()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Load more commits" })).toBeInTheDocument();
  });

  it("reveals a commit across a virtual boundary and consumes the request", async () => {
    const commits = Array.from({ length: 1_000 }, (_, row) =>
      commit({
        id: `c${row}`,
        shortId: `c${row}`,
        summary: `commit ${row}`,
        row,
      }),
    );
    useRepo.setState({
      graph: { commits, edges: [], laneCount: 1, wipLane: null, head: "c0", truncated: false },
      revealTarget: "c700",
    });

    render(<HistoryWorkspace />);

    const scroller = screen.getByTestId("history-scroll");
    await waitFor(() => expect(useRepo.getState().revealTarget).toBeNull());
    expect(scroller.scrollTop).toBeGreaterThan(600 * compactRowHeight);
    // jsdom does not perform native scrolling/layout; dispatch through Testing
    // Library so React observes the programmatic offset set by scrollToIndex.
    fireEvent.scroll(scroller);
    await waitFor(() => expect(screen.getByText("commit 700")).toBeInTheDocument());
  });

  it("reveals a stash row without selecting its file list", async () => {
    useRepo.setState({
      stashes: [{ ...stash, oid: "s1", message: "branch stash", baseOid: "c2" }],
      revealTarget: "s1",
      selectedCommit: null,
      selectedCommits: [],
      commitFiles: [],
    });

    render(<HistoryWorkspace />);

    await waitFor(() => expect(useRepo.getState().revealTarget).toBeNull());
    expect(useRepo.getState().selectedCommit).toBeNull();
    expect(useRepo.getState().commitFiles).toEqual([]);
    expect(screen.getByText("branch stash")).toBeInTheDocument();
  });

  it("pages in more history to reveal a tip past the loaded window", async () => {
    const expanded = Array.from({ length: 400 }, (_, row) =>
      commit({ id: `c${row}`, shortId: `c${row}`, summary: `commit ${row}`, row }),
    );
    invokeMock.mockImplementation((command: string) =>
      command === "commit_graph"
        ? Promise.resolve({
            commits: expanded,
            edges: [],
            laneCount: 1,
            wipLane: null,
            head: "c0",
            truncated: false,
          })
        : Promise.resolve([]),
    );
    useRepo.setState({
      graph: {
        commits: expanded.slice(0, 200),
        edges: [],
        laneCount: 1,
        wipLane: null,
        head: "c0",
        truncated: true,
      },
      graphLimit: 2_000,
      loading: false,
      loadingMoreHistory: false,
      revealTarget: "c300",
    });

    render(<HistoryWorkspace />);

    // The target sits past the 200 loaded rows, so the reveal pages in the next
    // window instead of toasting "outside the loaded history"…
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("commit_graph", { path: "/r", limit: 4_000 }),
    );
    // …and once the larger graph lands, the reveal resolves and is consumed.
    await waitFor(() => expect(useRepo.getState().revealTarget).toBeNull());
    fireEvent.scroll(screen.getByTestId("history-scroll"));
    await waitFor(() => expect(screen.getByText("commit 300")).toBeInTheDocument());
  });
});

describe("ColumnHandle", () => {
  it("calculates every resize from the drag start instead of a stale rendered width", () => {
    const onResize = vi.fn();
    render(<ColumnHandle left={210} onResize={onResize} />);

    fireEvent.mouseDown(screen.getByTitle("Drag to resize the graph column"), {
      clientX: 210,
    });
    fireEvent.mouseMove(window, { clientX: 225 });
    fireEvent.mouseMove(window, { clientX: 260 });

    expect(onResize.mock.calls).toEqual([[225], [260]]);

    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientX: 280 });
    expect(onResize).toHaveBeenCalledTimes(2);
  });
});
