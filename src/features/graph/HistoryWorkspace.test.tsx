import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitNode, FileChange, RepoGraph, StashEntry } from "../../lib/api";
import { useRepo } from "../../store/repo";
import { rowHeightFor, useUi } from "../../store/ui";
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
  color: 0,
  refs: [],
  ...over,
});
const c1 = commit({ id: "c1", shortId: "c1", summary: "alpha fix", row: 0 });
const c2 = commit({ id: "c2", shortId: "c2", summary: "beta feature", row: 1, parents: ["c1"] });
const c3 = commit({ id: "c3", shortId: "c3", summary: "gamma chore", row: 2, parents: ["c2"] });
const graph: RepoGraph = { commits: [c1, c2, c3], edges: [], laneCount: 1, head: "c3", truncated: false };
const file: FileChange = { path: "a.ts", status: "M", add: 1, del: 0 };
const stash: StashEntry = { index: 0, message: "my stash", oid: "s1", baseOid: "c2", baseTimestamp: 0, context: [] };
const compactRowHeight = rowHeightFor("Compact");

// A matched summary is split across <mark> highlight nodes, so match on full
// textContent and pick the innermost element, then climb to the row (role=button).
const deepestWithText = (text: string) => {
  const all = screen.getAllByText((_, node) => node?.textContent?.trim() === text);
  return all.find((el) => !all.some((o) => o !== el && el.contains(o)))!;
};
const rowFor = (msg: string) => deepestWithText(msg).closest('[role="button"]')!;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  useRepo.setState({
    summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c3", detached: false },
    graph,
    changes: { staged: [], unstaged: [] },
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
    graphWidth: null,
    density: "Compact",
    draggingFrom: null,
    actionMenu: null,
    commitMenu: null,
    stashMenu: null,
    stackedReview: null,
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
    useRepo.setState({ changes: { staged: [file], unstaged: [] }, stashes: [stash] });
    // Inert: WIP + stash render at full strength.
    const { unmount } = render(<HistoryWorkspace />);
    expect(screen.getByText("// WIP").closest("button")!.className).not.toMatch(/opacity-25/);
    expect(screen.getByText("my stash").closest("button")!.className).not.toMatch(/opacity-25/);
    unmount();
    // Searching: neither is a commit match, so both fade with the rest.
    useUi.setState({ histSearchOpen: true, histQuery: "beta" });
    render(<HistoryWorkspace />);
    expect(screen.getByText("// WIP").closest("button")!.className).toMatch(/opacity-25/);
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
    expect(useUi.getState().stashMenu).toBeNull();
    expect(useUi.getState().stackedReview).toBeNull();
  });

  it("opens anchored stash actions from the context menu with the original stash index", () => {
    useRepo.setState({ stashes: [{ ...stash, index: 3, message: "branch stash", oid: "s3" }] });
    render(<HistoryWorkspace />);

    fireEvent.contextMenu(screen.getByText("branch stash").closest("button")!, {
      clientX: 20,
      clientY: 30,
    });

    expect(useUi.getState().stashMenu).toMatchObject({
      index: 3,
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

    await waitFor(() => expect(screen.getByText("commit 500")).toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: /commit \d+/ }).length).toBeLessThanOrEqual(26);
    expect(screen.queryByText("commit 0")).not.toBeInTheDocument();
    expect(container.querySelector("canvas")?.style.height).toBe("884px");

    const row = rowFor("commit 500");
    fireEvent.click(row);
    expect(useRepo.getState().selectedCommit).toBe("c500");

    fireEvent.contextMenu(row, { clientX: 40, clientY: 60 });
    expect(useUi.getState().commitMenu).toMatchObject({ sha: "c500", x: 40, y: 60 });

    fireEvent.dragOver(row);
    fireEvent.drop(row, { clientX: 70, clientY: 80 });
    expect(useUi.getState().actionMenu).toMatchObject({
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
      graph: { commits, edges: [], laneCount: 1, head: "c0", truncated: false },
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
