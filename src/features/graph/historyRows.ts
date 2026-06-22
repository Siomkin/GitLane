import type { CommitNode, RepoGraph, StashContextCommit, StashEntry } from "@/lib/api";

export type HistoryRow =
  | { kind: "wip"; key: "wip" }
  | { kind: "commit"; key: string; commit: CommitNode }
  | { kind: "stash-context"; key: string; commit: StashContextCommit; rowIndex: number; markerLane: number }
  | { kind: "stash"; key: string; stash: StashEntry; anchor?: CommitNode; rowIndex: number; markerLane: number }
  | { kind: "stash-fallback"; key: "stash-fallback"; stashes: StashEntry[] }
  | { kind: "load-more"; key: "load-more" };

export interface StashConnector {
  key: string;
  stashRow: number;
  anchorRow: number;
  anchorLane: number;
  stashLane: number;
  color: number;
}

export interface HistoryRowsModel {
  rows: HistoryRow[];
  commits: CommitNode[];
  commitRowIndexById: Map<string, number>;
  revealRowIndexById: Map<string, number>;
  visualRowByGraphRow: number[];
  stashConnectors: StashConnector[];
  anchoredStashCount: number;
  maxMarkerLane: number;
  fallbackMarkerLane: number;
  unanchoredStashes: StashEntry[];
}

export function buildHistoryRows({
  graph,
  stashes,
  hasWip,
}: {
  graph: RepoGraph | null;
  stashes: StashEntry[];
  hasWip: boolean;
}): HistoryRowsModel {
  const commits = graph?.commits ?? [];
  const rows: HistoryRow[] = [];
  const commitRowIndexById = new Map<string, number>();
  const revealRowIndexById = new Map<string, number>();
  const visualRowByGraphRow: number[] = [];
  const stashConnectors: StashConnector[] = [];
  const stashesByBase = new Map<string, StashEntry[]>();
  const stashesByRejoin = new Map<string, Array<{ stash: StashEntry; context: StashContextCommit[] }>>();
  const timeAnchoredStashes: StashEntry[] = [];
  const unanchoredStashes: StashEntry[] = [];
  const commitIds = new Set(commits.map((commit) => commit.id));
  let maxMarkerLane = (graph?.laneCount ?? 1) - 1;
  const markerLaneFor = (anchorLane: number, stashRow: number, anchorRow: number) => {
    const occupied = occupiedLanesInSpan(graph, visualRowByGraphRow, stashRow, anchorRow);
    const rightmost = Math.max(anchorLane, ...occupied);
    const lane = rightmost + 1;
    maxMarkerLane = Math.max(maxMarkerLane, lane);
    return lane;
  };
  const newestTimestamp = commits[0]?.timestamp ?? null;
  const oldestTimestamp = commits.length > 0 ? commits[commits.length - 1].timestamp : null;

  for (const stash of stashes) {
    if (stash.baseOid && commitIds.has(stash.baseOid)) {
      const bucket = stashesByBase.get(stash.baseOid) ?? [];
      bucket.push(stash);
      stashesByBase.set(stash.baseOid, bucket);
    } else {
      const rejoin = stash.context.find((context) =>
        context.parents.some((parent) => commitIds.has(parent)),
      );
      const rejoinParent = rejoin?.parents.find((parent) => commitIds.has(parent));
      if (rejoin && rejoinParent) {
        const rejoinIndex = stash.context.indexOf(rejoin);
        const bucket = stashesByRejoin.get(rejoinParent) ?? [];
        bucket.push({ stash, context: stash.context.slice(0, rejoinIndex + 1) });
        stashesByRejoin.set(rejoinParent, bucket);
        continue;
      }
    }

    if (!(stash.baseOid && commitIds.has(stash.baseOid))) {
      if (
        stash.baseTimestamp != null &&
        newestTimestamp != null &&
        oldestTimestamp != null &&
        stash.baseTimestamp <= newestTimestamp &&
        stash.baseTimestamp >= oldestTimestamp
      ) {
        timeAnchoredStashes.push(stash);
      } else {
        unanchoredStashes.push(stash);
      }
    }
  }
  timeAnchoredStashes.sort((a, b) => (b.baseTimestamp ?? 0) - (a.baseTimestamp ?? 0));

  if (hasWip) {
    rows.push({ kind: "wip", key: "wip" });
  }

  let timeAnchorIndex = 0;
  const pushTimeAnchoredStashesNewerThan = (timestamp: number) => {
    const pending: Array<{ stash: StashEntry; stashRow: number }> = [];
    while (
      timeAnchorIndex < timeAnchoredStashes.length &&
      (timeAnchoredStashes[timeAnchorIndex].baseTimestamp ?? Number.NEGATIVE_INFINITY) >
        timestamp
    ) {
      const stash = timeAnchoredStashes[timeAnchorIndex++];
      const stashRow = rows.length;
      rows.push({
        kind: "stash",
        key: `stash:${stash.index}:${stash.oid}`,
        stash,
        rowIndex: stashRow,
        markerLane: 0,
      });
      revealRowIndexById.set(stash.oid, stashRow);
      pending.push({ stash, stashRow });
    }
    return pending;
  };

  for (const commit of commits) {
    const pendingTimeAnchors = pushTimeAnchoredStashesNewerThan(commit.timestamp);
    const pendingContextAnchors = stashesByRejoin.get(commit.id) ?? [];
    const pendingContextRows: Array<{ stash: StashEntry; stashRow: number }> = [];
    for (const pending of pendingContextAnchors) {
      const stashRow = rows.length;
      pendingContextRows.push({ stash: pending.stash, stashRow });
      rows.push({
        kind: "stash",
        key: `stash:${pending.stash.index}:${pending.stash.oid}`,
        stash: pending.stash,
        rowIndex: stashRow,
        markerLane: 0,
      });
      revealRowIndexById.set(pending.stash.oid, stashRow);
      for (const context of pending.context) {
        rows.push({
          kind: "stash-context",
          key: `stash-context:${pending.stash.index}:${context.id}`,
          commit: context,
          rowIndex: rows.length,
          markerLane: 0,
        });
      }
    }
    const commitRow = rows.length;
    rows.push({ kind: "commit", key: commit.id, commit });
    commitRowIndexById.set(commit.id, commitRow);
    revealRowIndexById.set(commit.id, commitRow);
    visualRowByGraphRow[commit.row] = commitRow;

    for (const pending of pendingTimeAnchors) {
      const markerLane = markerLaneFor(commit.lane, pending.stashRow, commitRow);
      const row = rows[pending.stashRow];
      if (row?.kind === "stash") {
        row.markerLane = markerLane;
      }
      stashConnectors.push({
        key: `stash:${pending.stash.index}:${pending.stash.oid}`,
        stashRow: pending.stashRow,
        anchorRow: commitRow,
        anchorLane: commit.lane,
        stashLane: markerLane,
        color: commit.color,
      });
    }
    for (const pending of pendingContextRows) {
      const markerLane = markerLaneFor(commit.lane, pending.stashRow, commitRow);
      for (let rowIndex = pending.stashRow; rowIndex < commitRow; rowIndex++) {
        const row = rows[rowIndex];
        if (row?.kind === "stash" || row?.kind === "stash-context") {
          row.markerLane = markerLane;
        }
      }
      stashConnectors.push({
        key: `stash:${pending.stash.index}:${pending.stash.oid}`,
        stashRow: pending.stashRow,
        anchorRow: commitRow,
        anchorLane: commit.lane,
        stashLane: markerLane,
        color: commit.color,
      });
    }

    for (const stash of stashesByBase.get(commit.id) ?? []) {
      const stashRow = rows.length;
      const markerLane = markerLaneFor(commit.lane, commitRow, stashRow);
      rows.push({
        kind: "stash",
        key: `stash:${stash.index}:${stash.oid}`,
        stash,
        anchor: commit,
        rowIndex: stashRow,
        markerLane,
      });
      revealRowIndexById.set(stash.oid, stashRow);
      stashConnectors.push({
        key: `stash:${stash.index}:${stash.oid}`,
        stashRow,
        anchorRow: commitRow,
        anchorLane: commit.lane,
        stashLane: markerLane,
        color: commit.color,
      });
    }
  }

  while (timeAnchorIndex < timeAnchoredStashes.length) {
    const stash = timeAnchoredStashes[timeAnchorIndex++];
    const lastCommit = commits[commits.length - 1];
    rows.push({
      kind: "stash",
      key: `stash:${stash.index}:${stash.oid}`,
      stash,
      rowIndex: rows.length,
      markerLane: 0,
    });
    revealRowIndexById.set(stash.oid, rows.length - 1);
    const lastCommitRow = lastCommit ? commitRowIndexById.get(lastCommit.id) : undefined;
    if (lastCommit && lastCommitRow !== undefined) {
      const markerLane = markerLaneFor(lastCommit.lane, lastCommitRow, rows.length - 1);
      const row = rows[rows.length - 1];
      if (row?.kind === "stash") {
        row.markerLane = markerLane;
      }
      stashConnectors.push({
        key: `stash:${stash.index}:${stash.oid}`,
        stashRow: rows.length - 1,
        anchorRow: lastCommitRow,
        anchorLane: lastCommit.lane,
        stashLane: markerLane,
        color: lastCommit.color,
      });
    }
  }

  const fallbackMarkerLane = unanchoredStashes.length > 0 ? markerLaneFor(0, 0, 0) : 0;

  if (unanchoredStashes.length > 0) {
    const fallbackRow = rows.length;
    rows.push({ kind: "stash-fallback", key: "stash-fallback", stashes: unanchoredStashes });
    for (const stash of unanchoredStashes) {
      revealRowIndexById.set(stash.oid, fallbackRow);
    }
  }

  if (graph?.truncated) {
    rows.push({ kind: "load-more", key: "load-more" });
  }

  return {
    rows,
    commits,
    commitRowIndexById,
    revealRowIndexById,
    visualRowByGraphRow,
    stashConnectors,
    anchoredStashCount: stashes.length - unanchoredStashes.length,
    maxMarkerLane,
    fallbackMarkerLane,
    unanchoredStashes,
  };
}

function occupiedLanesInSpan(
  graph: RepoGraph | null,
  visualRowByGraphRow: number[],
  rowA: number,
  rowB: number,
) {
  const occupied = new Set<number>();
  if (!graph) return occupied;
  const minRow = Math.min(rowA, rowB);
  const maxRow = Math.max(rowA, rowB);

  for (const commit of graph.commits) {
    const row = visualRowByGraphRow[commit.row];
    if (row !== undefined && row >= minRow && row <= maxRow) {
      occupied.add(commit.lane);
    }
  }

  for (const edge of graph.edges) {
    const fromRow = visualRowByGraphRow[edge.fromRow];
    const toRow = visualRowByGraphRow[edge.toRow];
    if (fromRow === undefined || toRow === undefined) continue;
    if (Math.max(fromRow, toRow) < minRow || Math.min(fromRow, toRow) > maxRow) continue;
    occupied.add(edge.fromLane);
    occupied.add(edge.toLane);
  }

  return occupied;
}
