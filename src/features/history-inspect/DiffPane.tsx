import type { FileDiff } from "@/lib/api";
import { VirtualUnifiedDiffBody } from "@/features/review/VirtualUnifiedDiffBody";
import { BinaryDiff } from "@/features/review/BinaryDiff";
import { DiffTruncatedNotice } from "@/features/review/DiffBody";
import { Skeleton } from "@/components/ui/Skeleton";

/** Shared diff pane for the file-history and compare views: a loading skeleton,
 * error/empty/binary states, then the unified diff with a "show full" affordance
 * when the backend capped it. The two views differ only in which store slice
 * feeds these props (selected revision vs selected compare file). */
export function DiffPane({
  loading,
  diff,
  error,
  emptyLabel,
  onShowFull,
}: {
  loading: boolean;
  diff: FileDiff | null;
  error: string | null;
  /** Shown when nothing is selected yet (and there's no error). */
  emptyLabel: string;
  /** Re-fetch the full (uncapped) diff; omit when no selection can drive it. */
  onShowFull?: () => void;
}) {
  if (loading) {
    return (
      <div className="space-y-1.5 p-3.5">
        {[60, 80, 50, 70, 90, 40, 75, 55, 85, 65].map((w, i) => (
          <Skeleton key={i} className="h-[18px]" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  }
  if (!diff) {
    if (error) {
      return (
        <div className="grid h-full place-content-center px-6 text-center text-sm text-rose-500">{error}</div>
      );
    }
    return <div className="grid h-full place-content-center text-sm text-neutral-400">{emptyLabel}</div>;
  }
  if (diff.binary) {
    return <BinaryDiff diff={diff} className="h-full overflow-auto" />;
  }
  // The diff scrolls inside its own windowed list, so the notice stays pinned
  // below it as a sibling rather than scrolling away at the end of the rows.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <VirtualUnifiedDiffBody hunks={diff.hunks} testId="inspect-diff-scroll" />
      </div>
      {diff.truncated && onShowFull && (
        <DiffTruncatedNotice onShowFull={onShowFull} message="Diff capped for performance." />
      )}
    </div>
  );
}
