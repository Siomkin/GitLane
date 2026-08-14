import { describe, expect, it } from "vitest";
import type { CommitNode, GraphEdge, RepoGraph } from "@/lib/api";
import { segmentIntersectsViewport } from "./graphViewport";
import type { StashConnector } from "./historyRows";
import { rowY } from "./palette";
import { buildGraphPaintIndex, queryGraphPaintIndex } from "./graphPaintIndex";

const commit = (id: string, row: number, overrides: Partial<CommitNode> = {}): CommitNode => ({
  id,
  shortId: id,
  summary: id,
  body: "",
  authorName: "",
  authorEmail: "",
  timestamp: 0,
  parents: [],
  lane: row % 4,
  row,
  refs: [],
  ...overrides,
});

const edge = (fromRow: number, toRow: number, color = 0): GraphEdge => ({
  fromRow,
  fromLane: fromRow % 4,
  toRow,
  toLane: toRow % 4,
  parentIndex: 0,
  color,
});

const connector = (key: string, stashRow: number, anchorRow: number): StashConnector => ({
  key,
  stashRow,
  anchorRow,
  stashLane: 5,
  anchorLane: 1,
  color: 0,
});

const graph = (commits: CommitNode[], edges: GraphEdge[], head = commits[0]?.id ?? null): RepoGraph => ({
  commits,
  edges,
  laneCount: 6,
  head,
  truncated: false,
});

describe("graphPaintIndex", () => {
  it("preserves source order and captured paint metadata in a mixed snapshot", () => {
    const commits = [
      commit("fallback-row", 4),
      commit("stash", 1, { stash: { index: 0, message: "saved" } }),
      commit("head", 0),
      commit("below", 9),
    ];
    const edges = [edge(4, 9, 1), edge(1, 4, 2), edge(0, 4, 3)];
    const stashConnectors = [
      connector("first", 5, 20),
      connector("second", 0, 2),
      connector("third", 4, 6),
    ];
    const visualRows: number[] = [];
    visualRows[0] = 2;
    visualRows[1] = 4;
    const index = buildGraphPaintIndex({
      graph: { ...graph(commits, edges, "head"), wipLane: 7 },
      visualRowByGraphRow: visualRows,
      stashConnectors,
      hasWip: true,
    });
    const candidates = queryGraphPaintIndex(index, {
      viewportTop: 30,
      viewportHeight: 20,
      rowHeight: 10,
    });

    // Row 4 is unmapped, so the existing WIP fallback places it at visual row 5.
    // Query output returns to graph source order even though the commit row index
    // itself is sorted by visual row.
    expect(candidates.commits.map(({ commit }) => commit.id)).toEqual([
      "fallback-row",
      "head",
    ]);
    expect(candidates.commits.map(({ visualRow }) => visualRow)).toEqual([5, 2]);
    expect(candidates.edges.map(({ edge: candidate }) => candidate)).toEqual(edges);
    expect(candidates.edges.map(({ stash }) => stash)).toEqual([false, true, false]);
    expect(candidates.edges[0]).toMatchObject({ fromVisualRow: 5, toVisualRow: 10 });
    expect(candidates.stashConnectors.map(({ connector: candidate }) => candidate.key)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(candidates.wipConnector).toMatchObject({
      headCommit: commits[2],
      headVisualRow: 2,
      lane: 7,
    });
    expect(candidates.wipNode).toBeNull();
    expect(index.counts).toMatchObject({ commits: 3, edges: 3, stashConnectors: 3 });
  });

  it("uses CSS-pixel viewport bounds with the existing one-row padding", () => {
    const index = buildGraphPaintIndex({
      graph: graph([commit("above-padding", 2), commit("outside", 1)], []),
      visualRowByGraphRow: [0, 1, 2],
      stashConnectors: [],
      hasWip: false,
    });

    // Row 2 center is y=25: it is outside [30, 40], but within one 10px row of
    // padding. Row 1 center (y=15) stays outside.
    const candidates = queryGraphPaintIndex(index, {
      viewportTop: 30,
      viewportHeight: 10,
      rowHeight: 10,
    });
    expect(candidates.commits.map(({ commit: candidate }) => candidate.id)).toEqual([
      "above-padding",
    ]);
  });

  it("matches zero-height reference clipping at compact and comfortable row heights", () => {
    const commits = [
      commit("head", 0),
      commit("two", 2),
      commit("stash", 3, { stash: { index: 2, message: "saved" } }),
      commit("five", 5),
      commit("nine", 9),
    ];
    const edges = [edge(0, 2), edge(5, 2), edge(3, 9), edge(9, 9)];
    const stashConnectors = [connector("near", 1, 4), connector("long", 0, 12)];
    const visualRows: number[] = [];
    visualRows[0] = 1;
    visualRows[2] = 4;
    visualRows[3] = 6;
    const hasWip = true;
    const index = buildGraphPaintIndex({
      graph: graph(commits, edges, "head"),
      visualRowByGraphRow: visualRows,
      stashConnectors,
      hasWip,
    });
    const visualRow = (graphRow: number) =>
      visualRows[graphRow] ?? graphRow + (hasWip ? 1 : 0);

    const densityResults: string[][] = [];
    for (const rowHeight of [34, 46]) {
      const results: string[] = [];
      for (const [viewportStartRow, viewportRowCount] of [
        [0, 2],
        [5, 3],
        [6, 0],
        [10, 1],
        [20, 4],
      ]) {
        const viewportTop = viewportStartRow * rowHeight;
        const viewportHeight = viewportRowCount * rowHeight;
        const candidates = queryGraphPaintIndex(index, {
          viewportTop,
          viewportHeight,
          rowHeight,
        });
        const visible = (fromRow: number, toRow: number) =>
          segmentIntersectsViewport(
            rowY(fromRow, rowHeight),
            rowY(toRow, rowHeight),
            viewportTop,
            viewportHeight,
            rowHeight,
          );

        expect(candidates.commits.map(({ commit: candidate }) => candidate.id)).toEqual(
          commits
            .filter(
              (candidate) =>
                !candidate.stash && visible(visualRow(candidate.row), visualRow(candidate.row)),
            )
            .map((candidate) => candidate.id),
        );
        expect(candidates.edges.map(({ edge: candidate }) => candidate)).toEqual(
          edges.filter((candidate) =>
            visible(visualRow(candidate.fromRow), visualRow(candidate.toRow)),
          ),
        );
        expect(candidates.stashConnectors.map(({ connector: candidate }) => candidate)).toEqual(
          stashConnectors.filter((candidate) =>
            visible(candidate.stashRow, candidate.anchorRow),
          ),
        );
        expect(candidates.wipConnector !== null).toBe(visible(0, visualRow(0)));
        expect(candidates.wipNode !== null).toBe(visible(0, 0));
        results.push(
          [
            candidates.commits.map(({ commit: candidate }) => candidate.id).join(","),
            candidates.edges.map(({ sourceOrder }) => sourceOrder).join(","),
            candidates.stashConnectors.map(({ sourceOrder }) => sourceOrder).join(","),
            String(candidates.wipConnector !== null),
            String(candidates.wipNode !== null),
          ].join("|"),
        );
      }
      densityResults.push(results);
    }
    expect(densityResults[0]).toEqual(densityResults[1]);
  });

  it.each([2_000, 10_000, 50_000])(
    "bounds a fixed viewport query at %i rows by depth plus returned crossings",
    (size) => {
      const commits = Array.from({ length: size }, (_, row) => commit(`c${row}`, row));
      const edges = Array.from({ length: size - 1 }, (_, row) => edge(row, row + 1));
      const stashConnectors = Array.from({ length: size - 1 }, (_, row) =>
        connector(`stash-${row}`, row, row + 1),
      );
      const index = buildGraphPaintIndex({
        graph: graph(commits, edges),
        visualRowByGraphRow: [],
        stashConnectors,
        hasWip: false,
      });
      const candidates = queryGraphPaintIndex(index, {
        viewportTop: Math.floor(size / 2) * 34,
        viewportHeight: 340,
        rowHeight: 34,
      });
      const depth = index.counts.edgeDepth;
      const connectorDepth = index.counts.stashConnectorDepth;

      expect(index.counts).toMatchObject({
        commits: size,
        edges: size - 1,
        stashConnectors: size - 1,
      });
      expect(depth).toBeLessThanOrEqual(Math.ceil(Math.log2(size)) + 1);
      expect(connectorDepth).toBeLessThanOrEqual(Math.ceil(Math.log2(size)) + 1);
      expect(candidates.commits.length).toBeLessThanOrEqual(13);
      expect(candidates.edges.length).toBeLessThanOrEqual(14);
      expect(candidates.stashConnectors.length).toBeLessThanOrEqual(14);
      expect(candidates.visits.commitBinarySearchSteps).toBeLessThanOrEqual(
        2 * (Math.ceil(Math.log2(size)) + 1),
      );
      expect(candidates.visits.edgeNodes).toBeLessThanOrEqual(
        2 * depth + candidates.edges.length,
      );
      expect(candidates.visits.edgeIntervals).toBeLessThanOrEqual(
        candidates.edges.length + candidates.visits.edgeNodes,
      );
      expect(candidates.visits.stashConnectorNodes).toBeLessThanOrEqual(
        2 * connectorDepth + candidates.stashConnectors.length,
      );
      expect(candidates.visits.stashConnectorIntervals).toBeLessThanOrEqual(
        candidates.stashConnectors.length + candidates.visits.stashConnectorNodes,
      );
    },
  );

  it("owns every long crossing interval once instead of copying it into row buckets", () => {
    const size = 10_000;
    const edges = Array.from({ length: size }, (_, sourceOrder) =>
      edge(0, 50_000, sourceOrder % 8),
    );
    const index = buildGraphPaintIndex({
      graph: graph([commit("head", 0)], edges),
      visualRowByGraphRow: [],
      stashConnectors: [],
      hasWip: false,
    });
    const candidates = queryGraphPaintIndex(index, {
      viewportTop: 25_000 * 34,
      viewportHeight: 34,
      rowHeight: 34,
    });

    expect(index.counts).toMatchObject({ edges: size, edgeNodes: size });
    expect(index.counts.edgeDepth).toBeLessThanOrEqual(Math.ceil(Math.log2(size)) + 1);
    expect(candidates.edges).toHaveLength(size);
    expect(candidates.visits).toMatchObject({ edgeNodes: size, edgeIntervals: size });
    expect(candidates.edges.map(({ edge: candidate }) => candidate)).toEqual(edges);
  });

  it("prunes ended subtrees beside one long interval crossing a far viewport", () => {
    const endedCount = 20_000;
    const crossing = edge(0, 30_000);
    const ended = Array.from({ length: endedCount }, (_, row) => edge(row, row + 1));
    const index = buildGraphPaintIndex({
      graph: graph([commit("head", 0)], [crossing, ...ended]),
      visualRowByGraphRow: [],
      stashConnectors: [],
      hasWip: false,
    });
    const candidates = queryGraphPaintIndex(index, {
      viewportTop: 25_000 * 34,
      viewportHeight: 34,
      rowHeight: 34,
    });

    expect(candidates.edges.map(({ edge: candidate }) => candidate)).toEqual([crossing]);
    expect(candidates.visits.edgeNodes).toBeLessThanOrEqual(index.counts.edgeDepth + 1);
    expect(candidates.visits.edgeIntervals).toBe(candidates.visits.edgeNodes);
  });
});
