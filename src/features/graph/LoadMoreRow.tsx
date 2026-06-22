import { cn } from "../../lib/cn";
import { focusRing } from "@/lib/ui";

/** The trailing "Load more commits" row shown when the graph is truncated. */
export function LoadMoreRow({
  top,
  rowHeight,
  loading,
  onLoadMore,
}: {
  top: number;
  rowHeight: number;
  loading: boolean;
  onLoadMore: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "absolute left-0 z-10 flex w-full items-center justify-center border-t border-black/5 bg-white/90 text-xs font-medium text-[var(--accent)] hover:bg-black/[0.025] disabled:cursor-wait disabled:text-neutral-400 dark:border-white/5 dark:bg-neutral-800/90 dark:hover:bg-white/[0.025]",
        focusRing,
      )}
      style={{ top, height: rowHeight }}
      onClick={onLoadMore}
      disabled={loading}
    >
      {loading ? "Loading more history…" : "Load more commits"}
    </button>
  );
}
