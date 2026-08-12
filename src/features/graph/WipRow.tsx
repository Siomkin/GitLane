import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { useUi, MenuKind } from "@/store/ui";
import { ChangeTypeCounts } from "@/features/changes/ChangeTypeCounts";
import type { ChangeSummary } from "@/lib/changeSummary";

/** The synthetic "uncommitted changes" row pinned to the top of history when
 * the working tree is dirty. Clicking it selects the WIP (the right inspector
 * shows the staged/unstaged diff); shift/cmd-click extends the commit selection
 * over it, folding the uncommitted work into the merged diff; right-click opens
 * stage/unstage/commit/stash. */
export function WipRow({
  top,
  rowHeight,
  graphColW,
  selected,
  dimmed,
  summary,
  onSelect,
}: {
  top: number;
  rowHeight: number;
  graphColW: number;
  selected: boolean;
  /** A commit search is active — the WIP is never a commit match, so fade it. */
  dimmed: boolean;
  /** Working-tree changes split by type, painted as "+a ~m −d" beside the badge. */
  summary: ChangeSummary;
  onSelect: (mods: { shift?: boolean; additive?: boolean }) => void;
}) {
  const openMenu = useUi((s) => s.openMenu);
  return (
    <button type="button"
      className={cn(
        "group absolute left-0 flex w-full cursor-pointer items-stretch text-left transition-opacity hover:bg-black/[0.025] dark:hover:bg-white/[0.025]",
        focusRing,
        selected && "bg-[var(--accent-soft)]",
        dimmed && !selected && "opacity-25 hover:opacity-100 focus-visible:opacity-100",
      )}
      style={{ top, height: rowHeight }}
      onClick={(e) => onSelect({ shift: e.shiftKey, additive: e.metaKey || e.ctrlKey })}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu({ kind: MenuKind.Wip, state: { x: e.clientX, y: e.clientY } });
      }}
    >
      <div className={cn("absolute bottom-0 left-0 top-0 w-[3px]", selected && "bg-[var(--accent)]")} />
      <div className="shrink-0" style={{ width: graphColW }} />
      <div className="z-10 flex min-w-0 flex-1 items-center gap-1.5 px-3.5">
        <span className="flex h-[22px] items-center whitespace-nowrap rounded-md bg-amber-100 px-2 font-mono text-[11px] font-semibold text-amber-700 dark:bg-amber-400/15 dark:text-amber-300">
          WIP
        </span>
        <ChangeTypeCounts summary={summary} />
      </div>
      <div className="z-10 flex shrink-0 items-center justify-end pl-3 pr-4 text-xs text-neutral-400">
        now
      </div>
    </button>
  );
}
