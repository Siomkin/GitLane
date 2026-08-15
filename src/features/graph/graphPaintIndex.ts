// Pure viewport index for the graph canvas. Construction captures one immutable
// graph/visual-row/stash/WIP snapshot; queries return only paint candidates that
// can cross the bounded canvas. No React, canvas, timers, or IPC.

import type { CommitNode, GraphEdge, RepoGraph } from "@/lib/api";
import type { StashConnector } from "./historyRows";

interface SourceOrdered {
  readonly sourceOrder: number;
}

export interface IndexedPaintCommit extends SourceOrdered {
  readonly commit: CommitNode;
  readonly visualRow: number;
}

export interface IndexedPaintEdge extends SourceOrdered {
  readonly edge: GraphEdge;
  readonly fromVisualRow: number;
  readonly toVisualRow: number;
  readonly stash: boolean;
}

export interface IndexedStashConnector extends SourceOrdered {
  readonly connector: StashConnector;
}

export interface IndexedWipConnector {
  readonly headCommit: CommitNode;
  readonly headVisualRow: number;
  readonly lane: number;
}

interface IndexedInterval<T extends SourceOrdered> {
  readonly start: number;
  readonly end: number;
  readonly value: T;
}

/**
 * Balanced interval tree invariants:
 *
 * - Intervals are sorted by start row and each is owned by exactly one node, so
 *   a long edge is never copied into every row/bucket it crosses.
 * - Median construction keeps the immutable tree height logarithmic.
 * - `maxEnd` prunes subtrees whose intervals all ended before the viewport;
 *   start ordering prunes the right side once all starts lie beyond it.
 */
interface IntervalNode<T extends SourceOrdered> {
  readonly interval: IndexedInterval<T>;
  readonly maxEnd: number;
  readonly left: IntervalNode<T> | null;
  readonly right: IntervalNode<T> | null;
}

interface IntervalIndex<T extends SourceOrdered> {
  readonly root: IntervalNode<T> | null;
  readonly intervalCount: number;
  readonly nodeCount: number;
  readonly depth: number;
}

export interface GraphPaintIndexCounts {
  readonly commits: number;
  readonly edges: number;
  readonly edgeNodes: number;
  readonly edgeDepth: number;
  readonly stashConnectors: number;
  readonly stashConnectorNodes: number;
  readonly stashConnectorDepth: number;
}

interface GraphPaintIndex {
  readonly commitsByRow: readonly IndexedPaintCommit[];
  readonly edges: IntervalIndex<IndexedPaintEdge>;
  readonly stashConnectors: IntervalIndex<IndexedStashConnector>;
  readonly wip: IndexedWipConnector | null;
  readonly counts: GraphPaintIndexCounts;
}

export interface GraphPaintQueryVisits {
  commitBinarySearchSteps: number;
  edgeNodes: number;
  edgeIntervals: number;
  stashConnectorNodes: number;
  stashConnectorIntervals: number;
}

export interface GraphPaintCandidates {
  readonly commits: readonly IndexedPaintCommit[];
  readonly edges: readonly IndexedPaintEdge[];
  readonly stashConnectors: readonly IndexedStashConnector[];
  readonly wipConnector: IndexedWipConnector | null;
  readonly wipNode: IndexedWipConnector | null;
  /** Deterministic structural work counters for scale tests; never wall-clock profiling. */
  readonly visits: GraphPaintQueryVisits;
}

const mappedVisualRow = (
  graphRow: number,
  visualRowByGraphRow: readonly number[],
  hasWip: boolean,
) => visualRowByGraphRow[graphRow] ?? graphRow + (hasWip ? 1 : 0);

export function buildGraphPaintIndex({
  graph,
  visualRowByGraphRow,
  stashConnectors,
  hasWip,
}: {
  graph: RepoGraph;
  visualRowByGraphRow: readonly number[];
  stashConnectors: readonly StashConnector[];
  hasWip: boolean;
}): GraphPaintIndex {
  const stashNodeRows = new Set<number>();
  const commitsByRow: IndexedPaintCommit[] = [];
  let headCommit: CommitNode | undefined;

  graph.commits.forEach((commit, sourceOrder) => {
    if (commit.stash) {
      stashNodeRows.add(commit.row);
      return;
    }
    if (!headCommit && commit.id === graph.head) headCommit = commit;
    commitsByRow.push({
      commit,
      visualRow: mappedVisualRow(commit.row, visualRowByGraphRow, hasWip),
      sourceOrder,
    });
  });
  commitsByRow.sort(
    (a, b) => a.visualRow - b.visualRow || a.sourceOrder - b.sourceOrder,
  );

  const edgeIntervals = graph.edges.map((edge, sourceOrder) => {
    const fromVisualRow = mappedVisualRow(edge.fromRow, visualRowByGraphRow, hasWip);
    const toVisualRow = mappedVisualRow(edge.toRow, visualRowByGraphRow, hasWip);
    const value: IndexedPaintEdge = {
      edge,
      fromVisualRow,
      toVisualRow,
      stash: stashNodeRows.has(edge.fromRow),
      sourceOrder,
    };
    return interval(value, fromVisualRow, toVisualRow);
  });
  const connectorIntervals = stashConnectors.map((connector, sourceOrder) =>
    interval<IndexedStashConnector>(
      { connector, sourceOrder },
      connector.stashRow,
      connector.anchorRow,
    ),
  );
  const edges = buildIntervalIndex(edgeIntervals);
  const indexedStashConnectors = buildIntervalIndex(connectorIntervals);
  const wip =
    hasWip && headCommit
      ? {
          headCommit,
          headVisualRow: mappedVisualRow(headCommit.row, visualRowByGraphRow, hasWip),
          lane: graph.wipLane ?? headCommit.lane,
        }
      : null;

  return {
    commitsByRow,
    edges,
    stashConnectors: indexedStashConnectors,
    wip,
    counts: {
      commits: commitsByRow.length,
      edges: edges.intervalCount,
      edgeNodes: edges.nodeCount,
      edgeDepth: edges.depth,
      stashConnectors: indexedStashConnectors.intervalCount,
      stashConnectorNodes: indexedStashConnectors.nodeCount,
      stashConnectorDepth: indexedStashConnectors.depth,
    },
  };
}

/** Select paint candidates for a CSS-pixel viewport. The conversion to visual
 * row coordinates exactly matches `rowY`; one `rowHeight` of padding preserves
 * the prior canvas clipping behavior. DPR never enters the index/query path. */
export function queryGraphPaintIndex(
  index: GraphPaintIndex,
  {
    viewportTop,
    viewportHeight,
    rowHeight,
  }: { viewportTop: number; viewportHeight: number; rowHeight: number },
): GraphPaintCandidates {
  const minRow = (viewportTop - rowHeight) / rowHeight - 0.5;
  const maxRow = (viewportTop + viewportHeight + rowHeight) / rowHeight - 0.5;
  const visits: GraphPaintQueryVisits = {
    commitBinarySearchSteps: 0,
    edgeNodes: 0,
    edgeIntervals: 0,
    stashConnectorNodes: 0,
    stashConnectorIntervals: 0,
  };

  const firstCommit = lowerBoundCommit(index.commitsByRow, minRow, visits);
  const afterCommit = upperBoundCommit(index.commitsByRow, maxRow, visits);
  const commits = sourceOrder(index.commitsByRow.slice(firstCommit, afterCommit));
  const edgeCandidates: IndexedPaintEdge[] = [];
  queryIntervalNode(
    index.edges.root,
    minRow,
    maxRow,
    edgeCandidates,
    visits,
    "edgeNodes",
    "edgeIntervals",
  );
  const stashConnectorCandidates: IndexedStashConnector[] = [];
  queryIntervalNode(
    index.stashConnectors.root,
    minRow,
    maxRow,
    stashConnectorCandidates,
    visits,
    "stashConnectorNodes",
    "stashConnectorIntervals",
  );
  const wipConnector =
    index.wip && intervalIntersects(0, index.wip.headVisualRow, minRow, maxRow)
      ? index.wip
      : null;
  const wipNode = index.wip && pointIntersects(0, minRow, maxRow) ? index.wip : null;

  return {
    commits,
    edges: sourceOrder(edgeCandidates),
    stashConnectors: sourceOrder(stashConnectorCandidates),
    wipConnector,
    wipNode,
    visits,
  };
}

function interval<T extends SourceOrdered>(
  value: T,
  from: number,
  to: number,
): IndexedInterval<T> {
  return { start: Math.min(from, to), end: Math.max(from, to), value };
}

function buildIntervalIndex<T extends SourceOrdered>(
  intervals: readonly IndexedInterval<T>[],
): IntervalIndex<T> {
  let nodeCount = 0;
  let depth = 0;
  const sorted = [...intervals].sort(
    (a, b) =>
      a.start - b.start || a.end - b.end || a.value.sourceOrder - b.value.sourceOrder,
  );
  const build = (low: number, high: number, level: number): IntervalNode<T> | null => {
    if (low >= high) return null;
    nodeCount += 1;
    depth = Math.max(depth, level);
    const mid = (low + high) >>> 1;
    const entry = sorted[mid];
    const left = build(low, mid, level + 1);
    const right = build(mid + 1, high, level + 1);
    return {
      interval: entry,
      maxEnd: Math.max(entry.end, left?.maxEnd ?? -Infinity, right?.maxEnd ?? -Infinity),
      left,
      right,
    };
  };

  return { root: build(0, sorted.length, 1), intervalCount: intervals.length, nodeCount, depth };
}

function queryIntervalNode<T extends SourceOrdered>(
  node: IntervalNode<T> | null,
  min: number,
  max: number,
  result: T[],
  visits: GraphPaintQueryVisits,
  nodeCounter: "edgeNodes" | "stashConnectorNodes",
  intervalCounter: "edgeIntervals" | "stashConnectorIntervals",
) {
  if (!node) return;
  visits[nodeCounter] += 1;
  if (node.left && node.left.maxEnd >= min) {
    queryIntervalNode(node.left, min, max, result, visits, nodeCounter, intervalCounter);
  }
  visits[intervalCounter] += 1;
  const entry = node.interval;
  if (entry.start <= max && entry.end >= min) result.push(entry.value);
  if (node.right && entry.start <= max && node.right.maxEnd >= min) {
    queryIntervalNode(node.right, min, max, result, visits, nodeCounter, intervalCounter);
  }
}

function lowerBoundCommit(
  commits: readonly IndexedPaintCommit[],
  row: number,
  visits: GraphPaintQueryVisits,
) {
  let low = 0;
  let high = commits.length;
  while (low < high) {
    visits.commitBinarySearchSteps += 1;
    const mid = (low + high) >>> 1;
    if (commits[mid].visualRow < row) low = mid + 1;
    else high = mid;
  }
  return low;
}

function upperBoundCommit(
  commits: readonly IndexedPaintCommit[],
  row: number,
  visits: GraphPaintQueryVisits,
) {
  let low = 0;
  let high = commits.length;
  while (low < high) {
    visits.commitBinarySearchSteps += 1;
    const mid = (low + high) >>> 1;
    if (commits[mid].visualRow <= row) low = mid + 1;
    else high = mid;
  }
  return low;
}

const intervalIntersects = (from: number, to: number, min: number, max: number) =>
  Math.max(from, to) >= min && Math.min(from, to) <= max;

const pointIntersects = (point: number, min: number, max: number) =>
  point >= min && point <= max;

/** Stable four-pass integer radix ordering keeps query work linear in returned
 * candidates while restoring the graph/connector arrays' original paint order. */
function sourceOrder<T extends SourceOrdered>(candidates: readonly T[]): T[] {
  if (candidates.length < 2) return [...candidates];
  let from = [...candidates];
  let to: T[] = new Array(candidates.length);
  for (let shift = 0; shift < 32; shift += 8) {
    const counts = new Uint32Array(256);
    for (const candidate of from) counts[(candidate.sourceOrder >>> shift) & 0xff] += 1;
    let offset = 0;
    for (let bucket = 0; bucket < counts.length; bucket++) {
      const count = counts[bucket];
      counts[bucket] = offset;
      offset += count;
    }
    for (const candidate of from) {
      const bucket = (candidate.sourceOrder >>> shift) & 0xff;
      to[counts[bucket]++] = candidate;
    }
    [from, to] = [to, from];
  }
  return from;
}
