import type { FileDiff } from "../../lib/api";
import { UnifiedDiffBody } from "../review/DiffBody";
import { BinaryDiff } from "../review/BinaryDiff";

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
          <div key={i} className="shim h-[18px] rounded bg-black/[0.05] dark:bg-white/[0.06]" style={{ width: `${w}%` }} />
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
  return (
    <div className="p-3.5">
      <UnifiedDiffBody hunks={diff.hunks} />
      {diff.truncated && onShowFull && <TruncatedNotice onShowFull={onShowFull} />}
    </div>
  );
}

/** Banner + action shown when the backend capped a diff at DIFF_LINE_LIMIT. */
function TruncatedNotice({ onShowFull }: { onShowFull: () => void }) {
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg border border-amber-500/15 bg-amber-500/[0.08] px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5 shrink-0">
        <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      </svg>
      Diff capped for performance.
      <button type="button"
        onClick={onShowFull}
        className="ml-auto h-7 rounded-md border border-amber-500/30 px-2.5 text-[11.5px] font-semibold hover:bg-amber-500/10"
      >
        Show full diff
      </button>
    </div>
  );
}
