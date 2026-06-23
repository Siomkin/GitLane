// Commit-history loading placeholder. Lives under features/graph/ (not the
// domain-free components/ui/) because it mirrors the history row shape; it
// composes the generic `Skeleton` primitive.

import { Skeleton } from "../../components/ui/Skeleton";

// Varied summary-bar widths (% of row) so the placeholder reads like real commit
// subjects of differing length instead of a uniform grid.
const HISTORY_SKELETON_WIDTHS = [46, 62, 38, 70, 52, 58, 42, 66, 50, 60];

/** Rows of a graph node + a commit-summary bar and author/time bars, shown while
 * the (potentially multi-MB) commit graph loads after a repo opens — so the
 * history pane reads as "loading" rather than an empty graph (GL-20). */
export function HistorySkeleton({ rows = 16 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading history" className="px-4 py-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 py-[7px]">
          <Skeleton className="h-2.5 w-2.5 shrink-0" style={{ borderRadius: "9999px" }} />
          <Skeleton
            className="h-3"
            style={{ width: `${HISTORY_SKELETON_WIDTHS[i % HISTORY_SKELETON_WIDTHS.length]}%` }}
          />
          <span className="flex-1" />
          <Skeleton className="h-2.5 w-16 shrink-0" />
          <Skeleton className="h-2.5 w-10 shrink-0" />
        </div>
      ))}
    </div>
  );
}
