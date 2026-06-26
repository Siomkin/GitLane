import { useCallback, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { GEOMETRY, graphLaneX } from "./palette";
import { GraphLayer } from "./GraphLayer";
import { HistorySearchBar } from "./HistorySearchBar";
import { isFiltering, matchingIds } from "./historyFilter";
import { buildHistoryRows } from "./historyRows";
import { useRepo } from "../../store/repo";
import { rowHeightFor, useUi } from "../../store/ui";
import { useRevealScroll } from "../../hooks/useRevealScroll";
import { CommitRow } from "./CommitRow";
import { StashRow, StashFallbackRow, StashContextRow } from "./StashRows";
import { WipRow } from "./WipRow";
import { LoadMoreRow } from "./LoadMoreRow";
import { ColumnHandle } from "./ColumnHandle";
import { HistorySkeleton } from "./HistorySkeleton";
import { LoadError } from "../../components/ui/Loading";

const HISTORY_OVERSCAN_ROWS = 8;

export const HistoryWorkspace = () => {
  const summary = useRepo((state) => state.summary);
  const graph = useRepo((state) => state.graph);
  const graphLoading = useRepo((state) => state.graphLoading);
  const error = useRepo((state) => state.error);
  const refresh = useRepo((state) => state.refresh);
  const changes = useRepo((state) => state.changes);
  const stashes = useRepo((state) => state.stashes);
  const selectedCommit = useRepo((state) => state.selectedCommit);
  const selectedCommits = useRepo((state) => state.selectedCommits);
  const selectCommitMulti = useRepo((state) => state.selectCommitMulti);
  const loadMoreHistory = useRepo((state) => state.loadMoreHistory);
  const loadingMoreHistory = useRepo((state) => state.loadingMoreHistory);
  const wipSelected = useRepo((state) => state.wipSelected);
  const selectWip = useRepo((state) => state.selectWip);
  const density = useUi((state) => state.density);
  const repoGraphWidth = useUi((state) => summary?.path ? state.graphWidthsByRepo[summary.path] : undefined);
  const setRepoGraphWidth = useUi((state) => state.setRepoGraphWidth);
  // The header (HistorySearchBar) owns the rest of the search/filter state; the
  // workspace only needs the query + kind to decide which commits to highlight.
  const histQuery = useUi((state) => state.histQuery);
  const histFilter = useUi((state) => state.histFilter);
  const rowHeight = rowHeightFor(density);
  // Membership lookup once per render instead of an O(n) .includes() per row
  // (mirrors the Set idiom GraphLayer already uses).
  const selectedSet = useMemo(() => new Set(selectedCommits), [selectedCommits]);
  // Include conflicted paths so a worktree with only unmerged files (e.g. a
  // `git am`/`stash apply` conflict with no detected operation) still shows the
  // WIP row, keeping the read-only Conflicts section reachable.
  const activeTabChangeCount =
    changes.staged.length + changes.unstaged.length + (changes.conflicted?.length ?? 0);
  const hasWip = activeTabChangeCount > 0;
  const rowModel = useMemo(
    () => buildHistoryRows({ graph, stashes, hasWip }),
    [graph, stashes, hasWip],
  );
  const commits = rowModel.commits;
  // Search + kind filter highlight rather than hide: the DAG, the synthetic
  // WIP/stash rows, and every commit stay in place at their graph coordinates;
  // matches keep full strength while everything else is dimmed, so the found
  // commits stand out without losing where they sit in the tree. `matchedIds`
  // is null when nothing is narrowing (the cue to render everything at full
  // strength).
  const filtering = isFiltering(histQuery, histFilter);
  const matchedIds = useMemo(
    () => matchingIds(commits, histQuery, histFilter),
    [commits, histQuery, histFilter],
  );
  const matchCount = matchedIds?.size ?? 0;
  // The graph is the heavy part of opening a repo; show its skeleton until it
  // lands rather than gating the whole shell on it (GL-20). `graph` may be null
  // briefly between the summary committing and the graph arriving.
  const showSkeleton = graphLoading && !graph;
  // The graph load failed after the summary published (commitGraph threw): the
  // skeleton is gone but there's no graph. Derive this from the repo/graph state
  // rather than the global `error` — an open repo with a settled-but-null graph is
  // a failure even after the user dismisses the global banner (which clears
  // `error`), so the retry path survives the dismiss instead of falling through to
  // an empty "0 commits" render (GL-20 review). An empty repository keeps a
  // non-null graph (zero commits), so it never trips this.
  const graphFailed = summary != null && !graphLoading && !graph;
  const countLabel = showSkeleton
    ? "Loading…"
    : graphFailed
      ? "History unavailable"
      : filtering
        ? `${matchCount} ${matchCount === 1 ? "match" : "matches"}`
        : `${commits.length} commits`;
  const rowCount = rowModel.rows.length;
  const laneCount = graph?.laneCount ?? 1;
  const fallbackNodeX = graphLaneX(rowModel.fallbackMarkerLane);
  const lanesNeeded = Math.max(laneCount, rowModel.maxMarkerLane + 1);
  // Cap the auto width generously (480px) so wide lane/marker counts aren't
  // clipped off-canvas; the user can still resize via repoGraphWidth.
  const autoGraphW = Math.min(480, Math.max(56, GEOMETRY.padLeft + lanesNeeded * GEOMETRY.laneWidth + 22));
  const graphColW = repoGraphWidth ?? autoGraphW;
  const resizeGraphColumn = useCallback(
    (width: number) => {
      if (summary?.path) setRepoGraphWidth(summary.path, width);
    },
    [setRepoGraphWidth, summary?.path],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const getItemKey = useCallback(
    (index: number) => {
      return rowModel.rows[index]?.key ?? index;
    },
    [rowModel.rows],
  );
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: HISTORY_OVERSCAN_ROWS,
    getItemKey,
    useFlushSync: false,
    // Keeps the first bounded window deterministic before the element observer
    // reports its real size (also mirrors the pre-layout state in jsdom).
    initialRect: { width: 0, height: rowHeight },
  });
  const virtualItems = virtualizer.getVirtualItems();
  const firstVirtualItem = virtualItems[0];
  const lastVirtualItem = virtualItems[virtualItems.length - 1];
  const viewportTop = firstVirtualItem?.start ?? 0;
  const viewportHeight = Math.max(
    rowHeight,
    (lastVirtualItem?.end ?? rowHeight) - viewportTop,
  );
  const surfaceHeight = Math.max(virtualizer.getTotalSize(), rowHeight);

  // The navigator's reveal request uses TanStack Virtual's index scrolling,
  // then pulses the landed commit once its virtual row mounts.
  const { flashId } = useRevealScroll({
    commits,
    commitRowIndexById: rowModel.commitRowIndexById,
    revealRowIndexById: rowModel.revealRowIndexById,
    filtering,
    virtualizer,
    ready: virtualItems.length > 0,
  });

  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:border-white/5 dark:bg-neutral-800">
      <HistorySearchBar countLabel={countLabel} selectedCount={selectedCommits.length} />

      <div
        ref={scrollRef}
        data-testid="history-scroll"
        className="min-h-0 flex-1 overflow-auto"
      >
        {showSkeleton ? (
          <HistorySkeleton />
        ) : graphFailed ? (
          <LoadError
            message={error ?? "Couldn't load commit history."}
            onRetry={() => void refresh()}
          />
        ) : (
        <div className="relative" style={{ height: surfaceHeight, minWidth: graphColW + 320 }}>
          {graph && (
            <GraphLayer
              viewportTop={viewportTop}
              viewportHeight={viewportHeight}
              hasWip={hasWip}
              rowHeight={rowHeight}
              graphWidth={graphColW}
              branchOffset={0}
              visualRowByGraphRow={rowModel.visualRowByGraphRow}
              stashConnectors={rowModel.stashConnectors}
              matchedIds={matchedIds}
            />
          )}
          <ColumnHandle left={graphColW} onResize={resizeGraphColumn} />

          {virtualItems.map((item) => {
            const row = rowModel.rows[item.index];
            if (!row) return null;

            if (row.kind === "stash") {
              return (
                <StashRow
                  key={item.key}
                  stash={row.stash}
                  top={item.start}
                  rowHeight={item.size}
                  graphColW={graphColW}
                  nodeX={graphLaneX(row.markerLane)}
                  selected={selectedSet.has(row.stash.oid)}
                  focused={selectedCommit === row.stash.oid}
                  flash={flashId === row.stash.oid}
                  dimmed={filtering}
                  onSelect={selectCommitMulti}
                />
              );
            }

            if (row.kind === "wip") {
              return (
                <WipRow
                  key={item.key}
                  top={item.start}
                  rowHeight={item.size}
                  graphColW={graphColW}
                  selected={wipSelected}
                  dimmed={filtering}
                  changeCount={activeTabChangeCount}
                  onSelect={selectWip}
                />
              );
            }

            if (row.kind === "stash-context") {
              return (
                <StashContextRow
                  key={item.key}
                  commit={row.commit}
                  top={item.start}
                  rowHeight={item.size}
                  graphColW={graphColW}
                  nodeX={graphLaneX(row.markerLane)}
                  dimmed={matchedIds !== null && !matchedIds.has(row.commit.id)}
                />
              );
            }

            if (row.kind === "commit") {
              return (
                <CommitRow
                  key={item.key}
                  commit={row.commit}
                  currentBranch={summary?.headBranch ?? null}
                  selected={selectedSet.has(row.commit.id)}
                  focused={selectedCommit === row.commit.id}
                  flash={flashId === row.commit.id}
                  dimmed={matchedIds !== null && !matchedIds.has(row.commit.id)}
                  query={histQuery}
                  top={item.start}
                  rowHeight={item.size}
                  graphColW={graphColW}
                  onSelect={selectCommitMulti}
                />
              );
            }

            if (row.kind === "stash-fallback") {
              return (
                <StashFallbackRow
                  key={item.key}
                  count={row.stashes.length}
                  top={item.start}
                  rowHeight={item.size}
                  graphColW={graphColW}
                  nodeX={fallbackNodeX}
                  dimmed={filtering}
                />
              );
            }

            return row.kind === "load-more" ? (
              <LoadMoreRow
                key={item.key}
                top={item.start}
                rowHeight={item.size}
                loading={loadingMoreHistory}
                onLoadMore={() => void loadMoreHistory()}
              />
            ) : null;
          })}
        </div>
        )}
      </div>
    </section>
  );
};
