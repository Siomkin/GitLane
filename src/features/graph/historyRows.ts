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

interface PlacedStash {
  stash: StashEntry;
  /** Commit the dashed connector points at — the base commit, the rejoin commit,
   * or (for floating stashes) the nearest loaded commit. Null skips the
   * connector entirely. */
  anchorId: string | null;
  stashRow: number;
  /** Count of stash-context rows following the stash row (rejoin stashes only). */
  contextRows: number;
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
  const commitIds = new Set(commits.map((commit) => commit.id));
  const commitById = new Map(commits.map((commit) => [commit.id, commit]));
  const oldestTimestamp = commits.length > 0 ? commits[commits.length - 1].timestamp : null;

  // Classify each stash by how the connector should attach. A base commit inside
  // the loaded window or a time-only placement both let the stash float to its
  // own creation time; a bounded first-parent context chain that rejoins the
  // graph instead pins to the rejoin commit (see below); otherwise it drops to
  // the fallback row.
  //
  // `baseOid` here is the connector target for time-placed stashes: the real
  // base for an in-window base, or null for a floating stash (whose off-window
  // base is replaced by the nearest loaded commit at flush time).
  const placeable: Array<{ stash: StashEntry; baseOid: string | null }> = [];
  // Rejoin stashes keyed by the loaded commit their context chain rejoins.
  // Emitted at that commit (NOT by stash time): their context rows are ancestor
  // commits, so floating the block to the stash's own time would hoist those old
  // commits above newer loaded history. Anchoring at the rejoin keeps the chain
  // chronologically adjacent to where it reconnects.
  const rejoinByParent = new Map<string, Array<{ stash: StashEntry; context: StashContextCommit[] }>>();
  const unanchoredStashes: StashEntry[] = [];

  for (const stash of stashes) {
    if (stash.baseOid && commitIds.has(stash.baseOid)) {
      placeable.push({ stash, baseOid: stash.baseOid });
      continue;
    }
    const rejoin = stash.context.find((context) =>
      context.parents.some((parent) => commitIds.has(parent)),
    );
    const rejoinParent = rejoin?.parents.find((parent) => commitIds.has(parent));
    if (rejoin && rejoinParent) {
      const rejoinIndex = stash.context.indexOf(rejoin);
      const bucket = rejoinByParent.get(rejoinParent) ?? [];
      bucket.push({ stash, context: stash.context.slice(0, rejoinIndex + 1) });
      rejoinByParent.set(rejoinParent, bucket);
      continue;
    }
    // A base resolved outside the loaded window (`baseTimestamp != null` means
    // the base commit exists, just isn't loaded). Place it by its own creation
    // time as long as that time reaches into the window — a recent stash on an
    // old base still belongs at the top, not the fallback. (`timestamp` is
    // always >= `baseTimestamp`, so this also covers a base sitting in-window.)
    if (
      stash.baseTimestamp != null &&
      oldestTimestamp != null &&
      stash.timestamp >= oldestTimestamp
    ) {
      placeable.push({ stash, baseOid: null });
    } else {
      unanchoredStashes.push(stash);
    }
  }

  // Newest first, matching the date-ordered commit walk so each stash slots in
  // at the point it was created.
  placeable.sort((a, b) => b.stash.timestamp - a.stash.timestamp);

  const placed: PlacedStash[] = [];

  if (hasWip) {
    rows.push({ kind: "wip", key: "wip" });
  }

  let nextStash = 0;
  // Emit every time-placed stash created after `timestamp` (i.e. that sorts above
  // the commit about to be pushed). `belowCommitId` is that commit — the fallback
  // connector target for floating stashes whose real base is outside the window.
  const flushStashesNewerThan = (timestamp: number | null, belowCommitId: string | null) => {
    while (
      nextStash < placeable.length &&
      (timestamp === null || placeable[nextStash].stash.timestamp > timestamp)
    ) {
      const { stash, baseOid } = placeable[nextStash++];
      const stashRow = rows.length;
      rows.push({
        kind: "stash",
        key: `stash:${stash.index}:${stash.oid}`,
        stash,
        rowIndex: stashRow,
        markerLane: 0,
      });
      revealRowIndexById.set(stash.oid, stashRow);
      placed.push({ stash, anchorId: baseOid ?? belowCommitId, stashRow, contextRows: 0 });
    }
  };

  // Emit the rejoin stashes (with their ancestor context chain) that reconnect at
  // `commitId`, just above that commit.
  const emitRejoinStashesAt = (commitId: string) => {
    for (const { stash, context } of rejoinByParent.get(commitId) ?? []) {
      const stashRow = rows.length;
      rows.push({
        kind: "stash",
        key: `stash:${stash.index}:${stash.oid}`,
        stash,
        rowIndex: stashRow,
        markerLane: 0,
      });
      revealRowIndexById.set(stash.oid, stashRow);
      for (const commit of context) {
        rows.push({
          kind: "stash-context",
          key: `stash-context:${stash.index}:${commit.id}`,
          commit,
          rowIndex: rows.length,
          markerLane: 0,
        });
      }
      placed.push({ stash, anchorId: commitId, stashRow, contextRows: context.length });
    }
  };

  for (const commit of commits) {
    flushStashesNewerThan(commit.timestamp, commit.id);
    emitRejoinStashesAt(commit.id);
    const commitRow = rows.length;
    rows.push({ kind: "commit", key: commit.id, commit });
    commitRowIndexById.set(commit.id, commitRow);
    revealRowIndexById.set(commit.id, commitRow);
    visualRowByGraphRow[commit.row] = commitRow;
  }
  // Stashes older than every loaded commit settle at the bottom, anchored to the
  // last (oldest) loaded commit above them.
  const lastCommit = commits[commits.length - 1] ?? null;
  flushStashesNewerThan(null, lastCommit ? lastCommit.id : null);

  // Resolve connectors + marker lanes once the full row layout is known: a
  // stash's base commit can sit far below it, so its row index (and the lanes
  // occupied around the stash) are only final after the walk completes.
  let maxMarkerLane = (graph?.laneCount ?? 1) - 1;
  for (const entry of placed) {
    if (entry.anchorId == null) continue;
    const anchorCommit = commitById.get(entry.anchorId);
    const anchorRow = commitRowIndexById.get(entry.anchorId);
    if (!anchorCommit || anchorRow === undefined) continue;

    // Keep the marker just right of the anchor's lane, clear of whatever crosses
    // the stash's own row(s). Deliberately *not* the full span down to the base
    // — measuring that would shove the marker past every branch the connector
    // passes (e.g. a dependabot fan), where GitKraken keeps it tucked beside the
    // mainline with the dashed line simply running through.
    const occupied = occupiedLanesInSpan(
      graph,
      visualRowByGraphRow,
      entry.stashRow,
      entry.stashRow + entry.contextRows,
    );
    const lane = Math.max(anchorCommit.lane, ...occupied) + 1;
    maxMarkerLane = Math.max(maxMarkerLane, lane);
    for (let rowIndex = entry.stashRow; rowIndex <= entry.stashRow + entry.contextRows; rowIndex++) {
      const row = rows[rowIndex];
      if (row?.kind === "stash" || row?.kind === "stash-context") {
        row.markerLane = lane;
      }
    }
    stashConnectors.push({
      key: `stash:${entry.stash.index}:${entry.stash.oid}`,
      stashRow: entry.stashRow,
      anchorRow,
      anchorLane: anchorCommit.lane,
      stashLane: lane,
      color: anchorCommit.color,
    });
  }

  let fallbackMarkerLane = 0;
  if (unanchoredStashes.length > 0) {
    const occupied = occupiedLanesInSpan(graph, visualRowByGraphRow, 0, 0);
    fallbackMarkerLane = Math.max(0, ...occupied) + 1;
    maxMarkerLane = Math.max(maxMarkerLane, fallbackMarkerLane);
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
