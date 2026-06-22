import { describe, expect, it } from "vitest";
import type { CommitNode, RepoGraph, StashEntry } from "@/lib/api";
import { buildHistoryRows } from "./historyRows";

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

const stash = (over: Partial<StashEntry>): StashEntry => ({
  index: 0,
  message: "stash",
  oid: "s1",
  baseOid: "c1",
  baseTimestamp: 300,
  context: [],
  ...over,
});

const c1 = commit({ id: "c1", shortId: "c1", summary: "base", timestamp: 300, row: 0 });
const c2 = commit({ id: "c2", shortId: "c2", summary: "middle", timestamp: 200, row: 1, parents: ["c1"] });
const c3 = commit({ id: "c3", shortId: "c3", summary: "tip", timestamp: 100, row: 2, parents: ["c2"] });
const graph: RepoGraph = {
  commits: [c1, c2, c3],
  edges: [],
  laneCount: 1,
  head: "c3",
  truncated: false,
};

describe("buildHistoryRows", () => {
  it("inserts anchored stashes immediately after their base commit", () => {
    const model = buildHistoryRows({
      graph,
      stashes: [stash({ index: 0, oid: "s0", baseOid: "c2" })],
      hasWip: false,
    });

    expect(model.rows.map((row) => row.kind)).toEqual(["commit", "commit", "stash", "commit"]);
    expect(model.rows.map((row) => row.key)).toEqual(["c1", "c2", "stash:0:s0", "c3"]);
    expect(model.commitRowIndexById.get("c3")).toBe(3);
    expect(model.visualRowByGraphRow).toEqual([0, 1, 3]);
    expect(model.stashConnectors).toMatchObject([
      { key: "stash:0:s0", stashRow: 2, anchorRow: 1, anchorLane: 0, stashLane: 1 },
    ]);
    expect(model.rows[2]).toMatchObject({ kind: "stash", markerLane: 1 });
    expect(model.revealRowIndexById.get("s0")).toBe(2);
  });

  it("keeps unanchored stashes out of the first graph rows", () => {
    const model = buildHistoryRows({
      graph,
      stashes: [
        stash({ index: 0, oid: "s0", baseOid: "missing", baseTimestamp: null }),
        stash({ index: 1, oid: "s1", baseOid: null, baseTimestamp: null }),
      ],
      hasWip: true,
    });

    expect(model.rows.map((row) => row.kind)).toEqual([
      "wip",
      "commit",
      "commit",
      "commit",
      "stash-fallback",
    ]);
    expect(model.commitRowIndexById.get("c1")).toBe(1);
    expect(model.unanchoredStashes.map((item) => item.index)).toEqual([0, 1]);
    expect(model.revealRowIndexById.get("s0")).toBe(4);
    expect(model.revealRowIndexById.get("s1")).toBe(4);
    expect(model.stashConnectors).toEqual([]);
  });

  it("preserves multiple stash actions on one base commit", () => {
    const model = buildHistoryRows({
      graph,
      stashes: [
        stash({ index: 0, oid: "s0", message: "newer", baseOid: "c1" }),
        stash({ index: 3, oid: "s3", message: "older", baseOid: "c1" }),
      ],
      hasWip: false,
    });

    const stashRows = model.rows.filter((row) => row.kind === "stash");
    expect(stashRows.map((row) => row.stash.index)).toEqual([0, 3]);
    expect(stashRows.map((row) => row.rowIndex)).toEqual([1, 2]);
    expect(model.rows.map((row) => row.key)).toEqual(["c1", "stash:0:s0", "stash:3:s3", "c2", "c3"]);
  });

  it("places dangling-base stashes by base timestamp inside the loaded graph window", () => {
    const model = buildHistoryRows({
      graph,
      stashes: [stash({ index: 1, oid: "s1", baseOid: "missing", baseTimestamp: 250 })],
      hasWip: false,
    });

    expect(model.rows.map((row) => row.key)).toEqual(["c1", "stash:1:s1", "c2", "c3"]);
    expect(model.unanchoredStashes).toEqual([]);
    expect(model.stashConnectors).toMatchObject([
      { key: "stash:1:s1", stashRow: 1, anchorRow: 2, anchorLane: 0, stashLane: 1 },
    ]);
    expect(model.rows[1]).toMatchObject({ kind: "stash", markerLane: 1 });
  });

  it("inserts bounded dangling stash context before the visible rejoin commit", () => {
    const model = buildHistoryRows({
      graph,
      stashes: [
        stash({
          index: 1,
          oid: "s1",
          baseOid: "missing",
          baseTimestamp: 250,
          context: [
            {
              id: "x1",
              shortId: "x1",
              summary: "stash base",
              authorName: "",
              authorEmail: "",
              timestamp: 250,
              parents: ["x2"],
            },
            {
              id: "x2",
              shortId: "x2",
              summary: "stash parent",
              authorName: "",
              authorEmail: "",
              timestamp: 225,
              parents: ["c2"],
            },
          ],
        }),
      ],
      hasWip: false,
    });

    expect(model.rows.map((row) => row.key)).toEqual([
      "c1",
      "stash:1:s1",
      "stash-context:1:x1",
      "stash-context:1:x2",
      "c2",
      "c3",
    ]);
    expect(model.stashConnectors).toMatchObject([
      { key: "stash:1:s1", stashRow: 1, anchorRow: 4, anchorLane: 0, stashLane: 1 },
    ]);
    expect(model.rows[1]).toMatchObject({ kind: "stash", markerLane: 1 });
    expect(model.rows[2]).toMatchObject({ kind: "stash-context", markerLane: 1 });
    expect(model.rows[3]).toMatchObject({ kind: "stash-context", markerLane: 1 });
  });

  it("places stash context to the right of lanes occupied through the context span", () => {
    const model = buildHistoryRows({
      graph: {
        ...graph,
        laneCount: 2,
        edges: [{ fromRow: 0, fromLane: 1, toRow: 1, toLane: 1, color: 1 }],
      },
      stashes: [
        stash({
          index: 1,
          oid: "s1",
          baseOid: "missing",
          baseTimestamp: 250,
          context: [
            {
              id: "x1",
              shortId: "x1",
              summary: "stash base",
              authorName: "",
              authorEmail: "",
              timestamp: 250,
              parents: ["c2"],
            },
          ],
        }),
      ],
      hasWip: false,
    });

    expect(model.stashConnectors).toMatchObject([
      { key: "stash:1:s1", stashRow: 1, anchorRow: 3, anchorLane: 0, stashLane: 2 },
    ]);
    expect(model.rows[1]).toMatchObject({ kind: "stash", markerLane: 2 });
    expect(model.rows[2]).toMatchObject({ kind: "stash-context", markerLane: 2 });
  });

  it("keeps timestamp-only stashes outside the loaded time window in fallback", () => {
    const model = buildHistoryRows({
      graph,
      stashes: [stash({ index: 1, oid: "s1", baseOid: "missing", baseTimestamp: 50 })],
      hasWip: false,
    });

    expect(model.rows.map((row) => row.key)).toEqual(["c1", "c2", "c3", "stash-fallback"]);
    expect(model.unanchoredStashes.map((item) => item.index)).toEqual([1]);
  });
});
