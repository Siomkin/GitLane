import type { RefLabel } from "../../../lib/api";
import { cn } from "../../../lib/cn";
import { TreeIcon } from "../../../components/ui/icons";
import { useUi } from "../../../store/ui";
import { useBranchRefDrag } from "../../../hooks/useBranchRefDrag";
import { RefPill } from "./RefPill";
import { useBranchWorktreeName } from "./useBranchWorktreeName";

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
    kind: "local",
    droppable: true,
    stopPropagation: true,
  });

  if (expanded) {
    return (
      <>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          title="Combine local + remote"
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

  const cls =
    "flex items-center gap-1 h-[22px] rounded-md text-[11px] font-medium whitespace-nowrap shrink-0 select-none max-w-[240px] cursor-grab active:cursor-grabbing";
  const style = current
    ? "pl-1 pr-1 bg-[var(--accent)] text-white shadow-sm"
    : "pl-1.5 pr-1 bg-white dark:bg-neutral-700 border border-black/10 dark:border-white/10 text-neutral-700 dark:text-neutral-200 shadow-sm";
  const remoteLabel = `${remotes.length} remote${remotes.length > 1 ? "s" : ""}`;

  return (
    <span
      {...dndProps}
      className={cn(cls, style)}
      style={isDropTarget ? { boxShadow: "inset 0 0 0 1.5px rgba(46,158,98,0.75)" } : undefined}
      title={`${local.name} — local + ${remoteLabel} in sync (click to split)`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu({ x: e.clientX, y: e.clientY, branch: local.name, isCurrent: current });
      }}
    >
      {current ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3 w-3 shrink-0">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : worktreeName ? (
        <TreeIcon className="h-3 w-3 shrink-0 text-neutral-400" />
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3 w-3 shrink-0 text-neutral-400">
          <path d="M6 3v15M18 9a9 9 0 0 1-9 9" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
        </svg>
      )}
      <span className="truncate">{base}</span>
      <span
        aria-label={remoteLabel}
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
