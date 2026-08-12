import { useCallback, useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { GEOMETRY, graphLaneX } from "./palette";
import { GraphLayer } from "./GraphLayer";
import { HistorySearchBar } from "./HistorySearchBar";
import { isFiltering, matchingIds } from "./historyFilter";
import { buildHistoryRows } from "./historyRows";
import { useRepo } from "@/store/repo";
import { WIP_SELECTION_ID } from "@/store/selection";
import { rowHeightFor, useUi } from "@/store/ui";
import { useRevealScroll } from "@/hooks/useRevealScroll";
import { CommitRow } from "./commit-row";
import { StashRow, StashFallbackRow, StashContextRow } from "./StashRows";
import { WipRow } from "./WipRow";
import { LoadMoreRow } from "./LoadMoreRow";
import { ColumnHandle } from "./ColumnHandle";
import { historyKeyDownHandler } from "./historyKeyboardNav";
import { HistorySkeleton } from "./HistorySkeleton";
import { LoadError } from "@/components/ui/Loading";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { changeTotal, summarizeChanges } from "@/lib/changeSummary";
import { repoIdentityKey } from "@/lib/worktrees";

const HISTORY_OVERSCAN_ROWS = 8;
// GL-23: minimum rows ahead of the trailing load-more row at which a near-bottom
// scroll starts paging in older history. The live threshold derives a rendered
// window's worth of rows (see `autoLoadAheadRows`) so the prefetch lead tracks
// density and viewport height instead of a fixed compact-density guess; this
// floor only covers the not-yet-measured first window.
const AUTO_LOAD_AHEAD_ROWS = 8;

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
  // Column widths key on the repository identity so every worktree of a repo
  // shares them (GL-109); pre-identity entries under the worktree path are
  // still read as a fallback and converge on the identity key at next resize.
  const graphWidthKey = summary ? repoIdentityKey(summary) : null;
  const repoGraphWidth = useUi((state) =>
    graphWidthKey
      ? state.graphWidthsByRepo[graphWidthKey] ??
        (summary?.path ? state.graphWidthsByRepo[summary.path] : undefined)
      : undefined,
  );
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
  const changeSummary = useMemo(() => summarizeChanges(changes), [changes]);
  const hasWip = changeTotal(changeSummary) > 0;
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
  // The ordered hits behind the search bar's clickable results panel — only
  // for a text query (a kind filter alone highlights in place, no list).
  const queryMatches = useMemo(
    () =>
      histQuery.trim() && matchedIds
        ? commits.filter((commit) => matchedIds.has(commit.id))
        : null,
    [commits, histQuery, matchedIds],
  );
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
  const wipLane = hasWip ? graph?.wipLane : undefined;
  const lanesNeeded = Math.max(laneCount, rowModel.maxMarkerLane + 1, (wipLane ?? -1) + 1);
  // Cap the auto width generously (480px) so wide lane/marker counts aren't
  // clipped off-canvas; the user can still resize via repoGraphWidth.
  const autoGraphW = Math.min(480, Math.max(56, GEOMETRY.padLeft + lanesNeeded * GEOMETRY.laneWidth + 22));
  const graphColW = repoGraphWidth ?? autoGraphW;
  const resizeGraphColumn = useCallback(
    (width: number) => {
      if (graphWidthKey) setRepoGraphWidth(graphWidthKey, width);
    },
    [setRepoGraphWidth, graphWidthKey],
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
    useScrollendEvent: true,
    // Keeps the first bounded window deterministic before the element observer
    // reports its real size (also mirrors the pre-layout state in jsdom).
    initialRect: { width: 0, height: rowHeight },
  });
  // Density changes `rowHeight`, but the virtualizer keeps its per-item
  // measurement cache — so rows keep their old height until a remount while the
  // canvas (which reads rowHeight directly) already repaints at the new size.
  // Reset the cache on a density change so the rows re-estimate immediately.
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight]);

  // ↑/↓ move the selection (Shift extends it); Enter opens the WIP row's changes.
  const onListKeyDown = historyKeyDownHandler(rowModel.rows, virtualizer, scrollRef);

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

  // GL-23: page in older history automatically as the trailing load-more row
  // scrolls toward the fold, so exploring a >2,000-commit repo no longer needs a
  // click every page. `loadMoreHistory()` owns every real guard (truncated /
  // loading / loadingMoreHistory / repo-switch generation) and sets
  // `loadingMoreHistory` synchronously before its first await, so re-running this
  // effect on each near-bottom render dispatches at most one in-flight request —
  // the manual LoadMoreRow shares the same action and stays the accessible
  // fallback. Keying the effect on the last rendered row index (a primitive)
  // keeps it idle until the bottom of the window actually moves.
  //
  // Deliberately inert while a search/kind filter is active: matches are
  // scattered through the dimmed full DAG, so silently appending another 2,000
  // rows below the viewport would be a confusing jump with no visible payoff.
  // The manual row remains the explicit way to extend a filtered window.
  const lastRowIndex = lastVirtualItem?.index ?? -1;
  const mountedRowCount = virtualItems.length;
  // Prefetch about one rendered window of rows ahead of the trailing boundary,
  // derived from the live window height so the lead distance tracks density and
  // viewport size instead of a fixed compact-density guess. The floor covers the
  // first render before the window is measured (viewportHeight starts at one row).
  const autoLoadAheadRows = Math.max(
    AUTO_LOAD_AHEAD_ROWS,
    Math.ceil(viewportHeight / rowHeight),
  );
  useEffect(() => {
    if (!graph?.truncated || filtering) return;
    // Every row is already mounted, so the whole window fits without scrolling —
    // there's no "end" to scroll toward. Leave paging to the visible manual
    // LoadMoreRow. (Real truncation only happens at ≥2,000 commits, which never
    // fits a viewport, so this just keeps tiny synthetic windows from auto-paging
    // on mount.)
    if (mountedRowCount >= rowCount) return;
    if (lastRowIndex < rowCount - 1 - autoLoadAheadRows) return;
    // A failed page clears `loadingMoreHistory` but leaves these deps unchanged,
    // so the effect deliberately does NOT auto-retry from the same spot — that
    // would hammer a failing backend in a tight loop. Recovery is the error toast
    // raised by loadMoreHistory plus the still-visible manual LoadMoreRow (or any
    // further scroll, which changes lastRowIndex). `loadingMoreHistory` is kept
    // out of the deps for the same reason.
    void loadMoreHistory();
  }, [
    graph?.truncated,
    filtering,
    lastRowIndex,
    mountedRowCount,
    rowCount,
    autoLoadAheadRows,
    loadMoreHistory,
  ]);

  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:border-white/5 dark:bg-neutral-800">
      <HistorySearchBar
        countLabel={countLabel}
        selectedCount={selectedCommits.length}
        matches={queryMatches}
      />

      <div
        ref={scrollRef}
        data-testid="history-scroll"
        // Focusable so arrow navigation survives rows unmounting as the virtual
        // window scrolls; -1 keeps it out of the tab order. Claiming focus on
        // mousedown (as the changed-file lists do) means a click anywhere in the
        // list arms the arrows — including after Escape closes the search, which
        // otherwise leaves focus on the body.
        tabIndex={-1}
        onMouseDown={() => scrollRef.current?.focus({ preventScroll: true })}
        onKeyDown={onListKeyDown}
        className="min-h-0 flex-1 overflow-auto outline-none"
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
            // The lane canvas is decorative: a paint crash degrades to just the
            // lanes (the commit rows below stay fully interactive) rather than
            // taking down the whole history view. The fallback is a subtle badge
            // pinned to the graph gutter — `pointer-events-none` so it can never
            // intercept a row click — giving sighted users a visible degraded
            // state, not only the screen-reader cue. Retries when a new graph
            // payload lands.
            <ErrorBoundary
              resetKeys={[graph]}
              fallback={() => (
                <div
                  role="status"
                  className="pointer-events-none absolute left-2 top-2 z-10 flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-50/90 px-2 py-1 text-[11px] font-medium text-amber-700 shadow-sm dark:border-amber-400/25 dark:bg-amber-950/80 dark:text-amber-300"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-amber-400" />
                  Commit graph unavailable
                </div>
              )}
            >
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
            </ErrorBoundary>
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
                  summary={changeSummary}
                  onSelect={(mods) =>
                    mods.shift || mods.additive
                      ? void selectCommitMulti(WIP_SELECTION_ID, mods)
                      : selectWip()
                  }
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
