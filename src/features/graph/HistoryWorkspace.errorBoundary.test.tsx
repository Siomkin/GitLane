import { render, screen } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitNode, RepoGraph } from "../../lib/api";
import { emptyAdvancedState } from "../../lib/advancedRepoState";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { HistoryWorkspace } from "./HistoryWorkspace";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// Stand in for the real lane canvas with a component that always throws, the way
// a malformed graph payload could blow up the painter at runtime. The dedicated
// boundary in HistoryWorkspace must catch this without dropping the commit rows.
vi.mock("./GraphLayer", () => ({
  GraphLayer: () => {
    throw new Error("canvas paint boom");
  },
}));

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

beforeAll(() => {
  // The boundary's componentDidCatch path logs through React's console.error;
  // silence it so the suite output stays readable.
  vi.spyOn(console, "error").mockImplementation(() => {});
  // jsdom reports 0 for layout boxes, so the virtualizer mounts no rows without
  // a measured scroll element. Give the history scroller a viewport so the
  // commit rows render (mirrors HistoryWorkspace.test.tsx).
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
});
afterAll(() => {
  vi.restoreAllMocks();
  for (const [property, descriptor] of [
    ["offsetHeight", offsetHeightDescriptor],
    ["offsetWidth", offsetWidthDescriptor],
    ["scrollHeight", scrollHeightDescriptor],
  ] as const) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, property, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, property);
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
const graph: RepoGraph = {
  commits: [
    commit({ id: "c1", shortId: "c1", summary: "alpha fix", row: 0 }),
    commit({ id: "c2", shortId: "c2", summary: "beta feature", row: 1, parents: ["c1"] }),
    commit({ id: "c3", shortId: "c3", summary: "gamma chore", row: 2, parents: ["c2"] }),
  ],
  edges: [],
  laneCount: 1,
  head: "c3",
  truncated: false,
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  useRepo.setState({
    summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c3", detached: false },
    graph,
    graphLoading: false,
    changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
    stashes: [],
    selectedCommit: null,
    selectedCommits: [],
    wipSelected: false,
  });
  useUi.setState({
    histQuery: "",
    histFilter: "all",
    graphWidthsByRepo: {},
    density: "Compact",
  });
});

describe("HistoryWorkspace — graph canvas error boundary", () => {
  it("contains a canvas paint crash and keeps the commit rows interactive", () => {
    render(<HistoryWorkspace />);

    // The boundary swapped the throwing canvas for its sr-only fallback…
    expect(screen.getByText("Commit graph unavailable")).toBeInTheDocument();
    // …while the commit rows (siblings outside the canvas boundary) survive.
    expect(screen.getByText("alpha fix")).toBeInTheDocument();
    expect(screen.getByText("gamma chore")).toBeInTheDocument();
    expect(screen.getByText("3 commits")).toBeInTheDocument();
  });
});
