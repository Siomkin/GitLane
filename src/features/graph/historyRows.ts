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
  // Only true commits anchor connectors / count toward "in window". Stash nodes
  // injected by the Rust layout are positioned + lane-reserved already, so they
  // ride along as graph rows; the timestamp-interleave below is left to handle
  // *only* stashes the backend couldn't place (base outside the loaded window).
  const commitIds = new Set(
    commits.filter((commit) => !commit.stash).map((commit) => commit.id),
  );
  const commitById = new Map(
    commits.filter((commit) => !commit.stash).map((commit) => [commit.id, commit]),
  );
  // Stashes already laid out as graph nodes (matched by oid = node id) — skip
  // them in the out-of-window classification so they aren't placed twice.
  const inGraphStashOids = new Set(
    commits.filter((commit) => commit.stash).map((commit) => commit.id),
  );
  const stashByOid = new Map(stashes.map((stash) => [stash.oid, stash]));
  const lastCommitNode = [...commits].reverse().find((commit) => !commit.stash) ?? null;
  const oldestTimestamp = lastCommitNode ? lastCommitNode.timestamp : null;

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
    // Already present in the graph — skip placing a second row. Either the backend
    // injected it as a stash node (reserved its lane) OR the stash commit is itself
    // reachable (e.g. HEAD detached at it), so the backend laid it out as a plain
    // commit and skipped injection; rendering the list entry too would duplicate it.
    if (inGraphStashOids.has(stash.oid) || commitIds.has(stash.oid)) {
      continue;
    }
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
  // Emit every time-placed stash created at-or-after `timestamp` (i.e. that sorts
  // above the commit about to be pushed). `belowCommitId` is that commit — the
  // fallback connector target for floating stashes whose real base is outside the
  // window. `>=` mirrors the Rust in-window interleave so an out-of-window stash
  // sharing a commit's exact second still slots above it, not into the fallback.
  const flushStashesNewerThan = (timestamp: number | null, belowCommitId: string | null) => {
    while (
      nextStash < placeable.length &&
      (timestamp === null || placeable[nextStash].stash.timestamp >= timestamp)
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

  // The nearest real commit emitted so far — the connector target for an
  // out-of-window floating stash flushed while the current node is itself an
  // injected stash (which has no commit to anchor to).
  let lastRealCommitId: string | null = null;
  for (const commit of commits) {
    // Out-of-window stashes interleave by their own time around every graph node
    // (commit or injected stash), so a floating stash still slots in chronologically.
    flushStashesNewerThan(commit.timestamp, commit.stash ? lastRealCommitId : commit.id);
    if (commit.stash) {
      // An in-window stash placed by the Rust layout: render it as a stash row at
      // the node's reserved lane. Its dashed edge to the base is a real graph edge
      // (drawn by the canvas), so no frontend connector is needed.
      const stashRow = rows.length;
      const entry = stashByOid.get(commit.id) ?? {
        index: commit.stash.index,
        message: commit.stash.message,
        oid: commit.id,
        timestamp: commit.timestamp,
        baseOid: commit.parents[0] ?? null,
        baseTimestamp: null,
        context: [],
      };
      rows.push({
        kind: "stash",
        key: `stash:${commit.stash.index}:${commit.id}`,
        stash: entry,
        rowIndex: stashRow,
        markerLane: commit.lane,
      });
      revealRowIndexById.set(commit.id, stashRow);
      visualRowByGraphRow[commit.row] = stashRow;
      continue;
    }
    emitRejoinStashesAt(commit.id);
    const commitRow = rows.length;
    rows.push({ kind: "commit", key: commit.id, commit });
    commitRowIndexById.set(commit.id, commitRow);
    revealRowIndexById.set(commit.id, commitRow);
    visualRowByGraphRow[commit.row] = commitRow;
    lastRealCommitId = commit.id;
  }
  // Stashes older than every loaded commit settle at the bottom, anchored to the
  // last (oldest) loaded commit above them.
  flushStashesNewerThan(null, lastCommitNode ? lastCommitNode.id : null);

  // Resolve connectors + marker lanes once the full row layout is known: a
  // stash's base commit can sit far below it, so its row index (and the lanes
  // occupied around the stash) are only final after the walk completes.
  // Build the graph-lane occupancy once. The previous helper rescanned every
  // commit and edge for every stash, making this phase O(stashes × graph).
  const maxOccupiedLaneByRow = buildLaneOccupancy(
    graph,
    visualRowByGraphRow,
    rows.length,
  );
  let maxMarkerLane = (graph?.laneCount ?? 1) - 1;
  for (const entry of placed) {
    if (entry.anchorId == null) continue;
    const anchorCommit = commitById.get(entry.anchorId);
    const anchorRow = commitRowIndexById.get(entry.anchorId);
    if (!anchorCommit || anchorRow === undefined) continue;

    // Keep the marker just right of the anchor's lane, clear of whatever crosses
    // the stash's own row(s). Deliberately *not* the full span down to the base
    // — measuring that would shove the marker past every branch the connector
    // passes (e.g. a dependabot fan), keeping it tucked beside the
    // mainline with the dashed line simply running through.
    const occupiedLane = maxLaneInSpan(
      maxOccupiedLaneByRow,
      entry.stashRow,
      entry.stashRow + entry.contextRows,
    );
    const lane = Math.max(anchorCommit.lane, occupiedLane) + 1;
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
    fallbackMarkerLane = Math.max(0, maxLaneInSpan(maxOccupiedLaneByRow, 0, 0)) + 1;
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
    // Real commits only — stash nodes are graph rows but shouldn't count toward
    // the commit total or be matched by the commit search.
    commits: commits.filter((commit) => !commit.stash),
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

/** Maximum graph lane crossing each visual row. Edge intervals are applied to
 * a range-chmax tree in O(edges log rows), then materialized once. Stash queries
 * scan only their bounded context span instead of the whole graph. */
function buildLaneOccupancy(
  graph: RepoGraph | null,
  visualRowByGraphRow: number[],
  rowCount: number,
): number[] {
  if (!graph || rowCount === 0) return new Array(rowCount).fill(-1);
  const tree = new Int32Array(rowCount * 4);
  tree.fill(-1);

  const update = (
    node: number,
    left: number,
    right: number,
    from: number,
    to: number,
    lane: number,
  ) => {
    if (from <= left && right <= to) {
      tree[node] = Math.max(tree[node], lane);
      return;
    }
    const middle = Math.floor((left + right) / 2);
    if (from <= middle) update(node * 2, left, middle, from, to, lane);
    if (to > middle) update(node * 2 + 1, middle + 1, right, from, to, lane);
  };

  const addRange = (from: number, to: number, lane: number) => {
    const start = Math.max(0, Math.min(from, to));
    const end = Math.min(rowCount - 1, Math.max(from, to));
    if (start <= end) update(1, 0, rowCount - 1, start, end, lane);
  };

  for (const commit of graph.commits) {
    const row = visualRowByGraphRow[commit.row];
    if (row !== undefined) addRange(row, row, commit.lane);
  }

  for (const edge of graph.edges) {
    const fromRow = visualRowByGraphRow[edge.fromRow];
    const toRow = visualRowByGraphRow[edge.toRow];
    if (fromRow === undefined || toRow === undefined) continue;
    addRange(fromRow, toRow, Math.max(edge.fromLane, edge.toLane));
  }

  const maxByRow = new Array<number>(rowCount).fill(-1);
  const materialize = (
    node: number,
    left: number,
    right: number,
    inherited: number,
  ) => {
    const lane = Math.max(inherited, tree[node]);
    if (left === right) {
      maxByRow[left] = lane;
      return;
    }
    const middle = Math.floor((left + right) / 2);
    materialize(node * 2, left, middle, lane);
    materialize(node * 2 + 1, middle + 1, right, lane);
  };
  materialize(1, 0, rowCount - 1, -1);
  return maxByRow;
}

function maxLaneInSpan(maxByRow: number[], rowA: number, rowB: number): number {
  const from = Math.max(0, Math.min(rowA, rowB));
  const to = Math.min(maxByRow.length - 1, Math.max(rowA, rowB));
  let max = -1;
  for (let row = from; row <= to; row += 1) max = Math.max(max, maxByRow[row] ?? -1);
  return max;
}
