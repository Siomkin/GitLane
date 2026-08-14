import { useEffect } from "react";

// GL-23: minimum rows ahead of the trailing load-more row at which a near-bottom
// scroll starts paging in older history. The live threshold derives a rendered
// window's worth of rows (see `autoLoadAheadRows`) so the prefetch lead tracks
// density and viewport height instead of a fixed compact-density guess; this
// floor only covers the not-yet-measured first window.
const AUTO_LOAD_AHEAD_ROWS = 8;

interface UseAutoLoadHistoryArgs {
  truncated: boolean | undefined;
  filtering: boolean;
  lastRowIndex: number;
  mountedRowCount: number;
  rowCount: number;
  viewportHeight: number;
  rowHeight: number;
  loadMoreHistory: () => unknown;
}

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
export function useAutoLoadHistory({
  truncated,
  filtering,
  lastRowIndex,
  mountedRowCount,
  rowCount,
  viewportHeight,
  rowHeight,
  loadMoreHistory,
}: UseAutoLoadHistoryArgs) {
  // Prefetch about one rendered window of rows ahead of the trailing boundary,
  // derived from the live window height so the lead distance tracks density and
  // viewport size instead of a fixed compact-density guess. The floor covers the
  // first render before the window is measured (viewportHeight starts at one row).
  const autoLoadAheadRows = Math.max(
    AUTO_LOAD_AHEAD_ROWS,
    Math.ceil(viewportHeight / rowHeight),
  );
  useEffect(() => {
    if (!truncated || filtering) return;
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
    truncated,
    filtering,
    lastRowIndex,
    mountedRowCount,
    rowCount,
    autoLoadAheadRows,
    loadMoreHistory,
  ]);
}
