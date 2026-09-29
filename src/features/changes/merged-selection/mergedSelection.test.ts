import { describe, it, expect } from "vitest";
import type { CommitNode, RepoGraph } from "@/lib/api";
import { mergedCommitRows, selectionCountLabel, workingUnionReview, workingUnionSpan } from "./mergedSelection";

const commit = (over: Partial<CommitNode>): CommitNode => ({
  id: "c",
  shortId: "c",
  summary: "",
  body: "",
  authorName: "Ada",
  authorEmail: "",
  timestamp: 0,
  parents: [],
  lane: 0,
  row: 0,
  refs: [],
  ...over,
});

// Display order is newest first: c3, (stash), c2, c1.
const graph: RepoGraph = {
  commits: [
    commit({ id: "c3", shortId: "abc3", summary: "third", authorName: "Ada", timestamp: 30 }),
    commit({ id: "s0", shortId: "s0", summary: "WIP", stash: { index: 0, message: "WIP" } }),
    commit({ id: "c2", shortId: "abc2", summary: "second", authorName: "Lin", timestamp: 20 }),
    commit({ id: "c1", shortId: "abc1", summary: "first", authorName: "Ada", timestamp: 10 }),
  ],
  edges: [],
  laneCount: 2,
  wipLane: null,
  head: "c3",
  truncated: false,
};

describe("mergedCommitRows", () => {
  it("returns selected commits newest-first regardless of selection order", () => {
    // Ids given oldest-first; rows must come back in graph (display) order.
    const rows = mergedCommitRows(graph, ["c1", "c3"]);
    expect(rows.map((r) => r.id)).toEqual(["c3", "c1"]);
    expect(rows[0]).toMatchObject({ shortId: "abc3", summary: "third", authorName: "Ada", timestamp: 30 });
  });

  it("drops stash nodes and ids absent from the graph", () => {
    const rows = mergedCommitRows(graph, ["c2", "s0", "missing"]);
    expect(rows.map((r) => r.id)).toEqual(["c2"]);
  });

  it("is empty for a null graph", () => {
    expect(mergedCommitRows(null, ["c1"])).toEqual([]);
  });
});

describe("selectionCountLabel", () => {
  it("pluralises the commit count", () => {
    expect(selectionCountLabel(1)).toBe("1 commit selected");
    expect(selectionCountLabel(12)).toBe("12 commits selected");
  });
});

describe("workingUnionSpan", () => {
  // c3 (HEAD) → c2 → c1 → c0 on one first-parent line.
  const line: RepoGraph = {
    ...graph,
    commits: [
      commit({ id: "c3", parents: ["c2"] }),
      commit({ id: "c2", parents: ["c1"] }),
      commit({ id: "c1", parents: ["c0"] }),
      commit({ id: "c0" }),
    ],
  };

  it("counts the commits a range spans, not just the picks", () => {
    const state = { graph: line, selectionDiff: null, selectedCommits: ["c3", "c1"] };
    expect(workingUnionSpan(state)).toBe(3);
    expect(workingUnionReview(state, "c0").headLabel).toBe("Working tree (3 commits)");
  });

  it("falls back to the pick count when the range can't be placed", () => {
    // `graph`'s commits have no parents, so c1 is off HEAD's line.
    const state = { graph, selectionDiff: null, selectedCommits: ["c3", "c1"] };
    expect(workingUnionSpan(state)).toBe(2);
  });
});
