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
  timestamp: 400,
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
  it("places a stash by its own time and connects down to its base commit", () => {
    // Recent stash (t=250) on an old base (c3): it floats up between c1 and c2
    // by its own time, with a connector running down to c3.
    const model = buildHistoryRows({
      graph,
      stashes: [stash({ index: 0, oid: "s0", timestamp: 250, baseOid: "c3", baseTimestamp: 100 })],
      hasWip: false,
    });

    expect(model.rows.map((row) => row.kind)).toEqual(["commit", "stash", "commit", "commit"]);
    expect(model.rows.map((row) => row.key)).toEqual(["c1", "stash:0:s0", "c2", "c3"]);
    expect(model.commitRowIndexById.get("c3")).toBe(3);
    expect(model.visualRowByGraphRow).toEqual([0, 2, 3]);
    expect(model.stashConnectors).toMatchObject([
      { key: "stash:0:s0", stashRow: 1, anchorRow: 3, anchorLane: 0, stashLane: 1 },
    ]);
    expect(model.rows[1]).toMatchObject({ kind: "stash", markerLane: 1 });
    expect(model.revealRowIndexById.get("s0")).toBe(1);
  });

  it("floats a stash newer than every commit to the top of history", () => {
    const model = buildHistoryRows({
      graph,
      stashes: [stash({ index: 0, oid: "s0", timestamp: 500, baseOid: "c2", baseTimestamp: 200 })],
      hasWip: false,
    });

    expect(model.rows.map((row) => row.key)).toEqual(["stash:0:s0", "c1", "c2", "c3"]);
    expect(model.stashConnectors).toMatchObject([
      { key: "stash:0:s0", stashRow: 0, anchorRow: 2, anchorLane: 0, stashLane: 1 },
    ]);
  });

  it("keeps unanchored stashes out of the graph rows", () => {
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

  it("orders multiple stashes by their own time, newest first", () => {
    const model = buildHistoryRows({
      graph,
      stashes: [
        stash({ index: 0, oid: "s0", message: "newer", timestamp: 400, baseOid: "c1" }),
        stash({ index: 3, oid: "s3", message: "older", timestamp: 350, baseOid: "c1" }),
      ],
      hasWip: false,
    });

    const stashRows = model.rows.filter((row) => row.kind === "stash");
    expect(stashRows.map((row) => row.stash.index)).toEqual([0, 3]);
    expect(stashRows.map((row) => row.rowIndex)).toEqual([0, 1]);
    expect(model.rows.map((row) => row.key)).toEqual(["stash:0:s0", "stash:3:s3", "c1", "c2", "c3"]);
  });

  it("places dangling-base stashes by their own time inside the loaded window", () => {
    const model = buildHistoryRows({
      graph,
      stashes: [stash({ index: 1, oid: "s1", timestamp: 250, baseOid: "missing", baseTimestamp: 250 })],
      hasWip: false,
    });

    expect(model.rows.map((row) => row.key)).toEqual(["c1", "stash:1:s1", "c2", "c3"]);
    expect(model.unanchoredStashes).toEqual([]);
    expect(model.stashConnectors).toMatchObject([
      { key: "stash:1:s1", stashRow: 1, anchorRow: 2, anchorLane: 0, stashLane: 1 },
    ]);
    expect(model.rows[1]).toMatchObject({ kind: "stash", markerLane: 1 });
  });

  it("floats a recent stash whose base is older than the loaded window", () => {
    // Base time (50) sits below the oldest loaded commit (100), but the stash
    // itself was created recently (500) — it belongs at the top, anchored to the
    // nearest loaded commit, not banished to the fallback row.
    const model = buildHistoryRows({
      graph,
      stashes: [stash({ index: 1, oid: "s1", timestamp: 500, baseOid: "missing", baseTimestamp: 50 })],
      hasWip: false,
    });

    expect(model.rows.map((row) => row.key)).toEqual(["stash:1:s1", "c1", "c2", "c3"]);
    expect(model.unanchoredStashes).toEqual([]);
    expect(model.stashConnectors).toMatchObject([
      { key: "stash:1:s1", stashRow: 0, anchorRow: 1, anchorLane: 0, stashLane: 1 },
    ]);
  });

  it("inserts bounded dangling stash context after the stash row", () => {
    const model = buildHistoryRows({
      graph,
      stashes: [
        stash({
          index: 1,
          oid: "s1",
          timestamp: 250,
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

  it("places stash context to the right of lanes occupied across the stash rows", () => {
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
          timestamp: 250,
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

  it("anchors a rejoin stash's context at the rejoin commit, not the stash's own time", () => {
    // The stash was created recently (500), but its context is an *ancestor*
    // commit (250). Floating the block to the stash's time would hoist that old
    // commit above c1 (300); it must stay beside the rejoin commit c2 instead.
    const model = buildHistoryRows({
      graph,
      stashes: [
        stash({
          index: 1,
          oid: "s1",
          timestamp: 500,
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

    expect(model.rows.map((row) => row.key)).toEqual([
      "c1",
      "stash:1:s1",
      "stash-context:1:x1",
      "c2",
      "c3",
    ]);
    expect(model.stashConnectors).toMatchObject([
      { key: "stash:1:s1", stashRow: 1, anchorRow: 3, anchorLane: 0, stashLane: 1 },
    ]);
  });

  it("keeps stashes outside the loaded time window in fallback", () => {
    const model = buildHistoryRows({
      graph,
      stashes: [stash({ index: 1, oid: "s1", timestamp: 50, baseOid: "missing", baseTimestamp: 50 })],
      hasWip: false,
    });

    expect(model.rows.map((row) => row.key)).toEqual(["c1", "c2", "c3", "stash-fallback"]);
    expect(model.unanchoredStashes.map((item) => item.index)).toEqual([1]);
  });
});
