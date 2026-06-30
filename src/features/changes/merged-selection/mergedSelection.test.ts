import { describe, it, expect } from "vitest";
import type { CommitNode, RepoGraph } from "../../../lib/api";
import { mergedCommitRows, relativeCommitDate, selectionCountLabel } from "./mergedSelection";

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
  color: 0,
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

describe("relativeCommitDate", () => {
  const now = 1_000_000; // seconds
  const nowMs = now * 1000;
  it("formats sub-minute, minute, hour, day, month and year ages", () => {
    expect(relativeCommitDate(now, nowMs)).toBe("just now");
    expect(relativeCommitDate(now - 5 * 60, nowMs)).toBe("5m ago");
    expect(relativeCommitDate(now - 3 * 3600, nowMs)).toBe("3h ago");
    expect(relativeCommitDate(now - 2 * 86400, nowMs)).toBe("2d ago");
    expect(relativeCommitDate(now - 60 * 86400, nowMs)).toBe("2mo ago");
    expect(relativeCommitDate(now - 800 * 86400, nowMs)).toBe("2y ago");
  });

  it("never goes negative for a future timestamp", () => {
    expect(relativeCommitDate(now + 100, nowMs)).toBe("just now");
  });
});
