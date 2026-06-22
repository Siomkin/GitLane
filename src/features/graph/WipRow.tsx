import { cn } from "../../lib/cn";
import { focusRing } from "@/lib/ui";

/** The synthetic "uncommitted changes" row pinned to the top of history when
 * the working tree is dirty. Clicking it selects the WIP (the right inspector
 * shows the staged/unstaged diff). */
export function WipRow({
  top,
  rowHeight,
  graphColW,
  selected,
  dimmed,
  changeCount,
  onSelect,
}: {
  top: number;
  rowHeight: number;
  graphColW: number;
  selected: boolean;
  /** A commit search is active — the WIP is never a commit match, so fade it. */
  dimmed: boolean;
  changeCount: number;
  onSelect: () => void;
}) {
  return (
    <button
      className={cn(
        "group absolute left-0 flex w-full cursor-pointer items-stretch bg-transparent text-left transition-opacity hover:bg-black/[0.025] dark:hover:bg-white/[0.025]",
        focusRing,
        selected && "bg-[var(--accent-soft)]",
        dimmed && !selected && "opacity-25 hover:opacity-100 focus-visible:opacity-100",
      )}
      style={{ top, height: rowHeight }}
      onClick={onSelect}
    >
      <div className={cn("absolute bottom-0 left-0 top-0 w-[3px]", selected && "bg-[var(--accent)]")} />
      <div className="shrink-0" style={{ width: graphColW }} />
      <div className="z-10 flex min-w-0 flex-1 items-center gap-1.5 px-3.5">
        <span className="flex h-[22px] items-center whitespace-nowrap rounded-md bg-amber-100 px-2 font-mono text-[11px] font-semibold text-amber-700 dark:bg-amber-400/15 dark:text-amber-300">
          // WIP
        </span>
        <span className="flex items-center gap-1 text-[12px] text-amber-600 dark:text-amber-300/80">
          <PencilIcon />
          {changeCount}
        </span>
      </div>
      <div className="z-10 flex shrink-0 items-center justify-end pl-3 pr-4 text-xs text-neutral-400">
        now
      </div>
    </button>
  );
}

function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
