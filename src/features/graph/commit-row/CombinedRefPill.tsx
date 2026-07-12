import { BranchKind, type RefLabel } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useUi } from "@/store/ui";
import { useBranchRefDrag } from "@/hooks/useBranchRefDrag";
import { RefPill } from "./RefPill";
import { useBranchWorktreeName } from "./useBranchWorktreeName";
import { combinedRefPillModel } from "./refPillModel";
import { PillGlyph } from "./PillGlyph";

/** A local branch + its in-sync remote ref(s) shown as one pill. Collapsed it
 * acts as the local branch (drag source, right-click menu); a single click
 * splits it into the individual RefPills — each of which already owns the full
 * drag / checkout / context-menu behaviour. A leading chevron recombines them. */
export function CombinedRefPill({
  base,
  local,
  remotes,
  current,
  expanded,
  onToggle,
  targetSha,
}: {
  base: string;
  local: RefLabel;
  remotes: RefLabel[];
  current: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** The commit this pill sits on — threaded to the split-out RefPills. */
  targetSha: string;
}) {
  const openContextMenu = useUi((state) => state.openContextMenu);
  const worktreeName = useBranchWorktreeName(local.name, !current);
  // Collapsed, the pill stands in for the local branch (the usual drag/menu
  // target); the remote ref is reachable by splitting.
  const { isDropTarget, dndProps } = useBranchRefDrag(local.name, {
    draggable: true,
    kind: BranchKind.Local,
    droppable: true,
    stopPropagation: true,
  });

  if (expanded) {
    return (
      <>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          title="Combine local + remote"
          aria-label="Combine local + remote"
          className="grid h-[22px] w-[18px] shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="h-3.5 w-3.5">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <RefPill refLabel={local} current={current} targetSha={targetSha} />
        {remotes.map((r) => (
          <RefPill key={r.name} refLabel={r} current={false} targetSha={targetSha} />
        ))}
      </>
    );
  }

  const model = combinedRefPillModel(local.name, remotes.length, current, worktreeName);

  return (
    <span
      {...dndProps}
      role="button"
      tabIndex={0}
      aria-label={model.title}
      className={cn(model.className, "outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]")}
      style={isDropTarget ? { boxShadow: "inset 0 0 0 1.5px rgba(46,158,98,0.75)" } : undefined}
      title={model.title}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onToggle();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu({ x: e.clientX, y: e.clientY, branch: local.name, isCurrent: current });
      }}
    >
      <PillGlyph icon={model.icon} />
      <span className="truncate">{base}</span>
      <span
        aria-label={model.remoteLabel}
        className={cn(
          "ml-0.5 flex items-center gap-0.5 rounded px-1 py-0.5",
          current ? "bg-white/20 text-white" : "bg-black/[0.05] text-neutral-400 dark:bg-white/10",
        )}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-2.5 w-2.5 shrink-0">
          <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.34 9.5 4 4 0 0 0 7 17.5" />
        </svg>
        {remotes.length > 1 && (
          <span className="text-[9px] font-semibold leading-none">{remotes.length}</span>
        )}
      </span>
    </span>
  );
}
