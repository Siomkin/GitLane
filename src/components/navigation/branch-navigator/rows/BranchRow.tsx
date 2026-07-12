import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import type { BranchSyncState } from "@/lib/api";
import { syncBadgeLabel, syncTitle } from "@/lib/branchSync";
import { useUi } from "@/store/ui";
import { useTruncatedTooltip } from "@/components/chrome/overlays";
import { HighlightMatch } from "@/components/ui/HighlightMatch";
import { TreeIcon } from "@/components/ui/icons";
import { RowKind } from "../refs";
import { useBranchRefDrag } from "@/hooks/useBranchRefDrag";
import { useRevealNavigate } from "../useRowActions";
import { RowGlyph } from "./RowGlyph";
import { DIM_CLASS } from "./rowStyles";

/** A branch / remote / tag row. Click jumps the graph to its tip and closes the
 * popup; checkout lives on the right-click context menu (single-click closes the
 * popup, so a double-click gesture here can't land reliably). Tags aren't drag
 * sources, but they do get a tag-specific right-click menu. */
export function BranchRow({
  name,
  kind,
  oid,
  isCurrent = false,
  dimmed = false,
  query = "",
  sync = null,
  worktree = null,
}: {
  name: string;
  kind: RowKind;
  oid?: string;
  isCurrent?: boolean;
  dimmed?: boolean;
  /** Active search term — marks the matched substring in the name (3+ chars). */
  query?: string;
  sync?: BranchSyncState | null;
  /** Name of the worktree holding this branch (when not the open one). */
  worktree?: string | null;
}) {
  const navigate = useRevealNavigate();
  const openContextMenu = useUi((s) => s.openContextMenu);
  const openTagMenu = useUi((s) => s.openTagMenu);
  const tip = useTruncatedTooltip(name);
  const draggable = kind !== RowKind.Tag;
  const syncLabel = kind === RowKind.Local ? syncBadgeLabel(sync) : null;
  const { isDropTarget, dndProps } = useBranchRefDrag(
    name,
    draggable
      ? { draggable: true, kind, droppable: true }
      : { draggable: false },
  );

  return (
    <div
      {...tip}
      {...dndProps}
      role="button"
      tabIndex={0}
      aria-label={isCurrent ? `Current ${kind} ${name}` : `Reveal ${kind} ${name}`}
      className={cn(
        "flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-[13px] transition-opacity",
        focusRing,
        isCurrent
          ? "bg-[var(--accent-soft)] font-medium text-[color:var(--accent)]"
          : kind === RowKind.Remote
            ? "text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
            : "text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5",
        dimmed && DIM_CLASS,
      )}
      style={{ boxShadow: isDropTarget ? "inset 0 0 0 1.5px rgba(46,158,98,0.7)" : undefined }}
      onClick={() => navigate(oid)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigate(oid);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        // Tags are immutable pointers — they get their own menu (checkout /
        // branch / worktree / copy) keyed off the tagged commit oid.
        if (kind === RowKind.Tag) {
          if (oid) openTagMenu({ x: e.clientX, y: e.clientY, name, sha: oid });
          return;
        }
        openContextMenu({ x: e.clientX, y: e.clientY, branch: name, isCurrent });
      }}
    >
      {worktree && !isCurrent ? (
        // A branch parked in a worktree gets the neutral worktree glyph in
        // place of the branch fork — the same icon as the Worktrees section, so
        // the two read as the same thing. The tooltip names which worktree.
        <span
          title={`Checked out in worktree: ${worktree}`}
          aria-label={`Checked out in worktree ${worktree}`}
          className="shrink-0 text-neutral-400"
        >
          <TreeIcon className="h-3.5 w-3.5" />
        </span>
      ) : (
        <RowGlyph kind={kind} current={isCurrent} />
      )}
      <span data-truncate className="min-w-0 flex-1 truncate">
        <HighlightMatch text={name} query={query} />
      </span>
      {syncLabel && (
        <span
          title={syncTitle(sync)}
          className={cn(
            "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
            sync?.status === "ahead" || sync?.status === "behind"
              ? "bg-[var(--accent-soft)] text-[color:var(--accent)]"
              : sync?.status === "diverged" || sync?.status === "staleUpstream"
                ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                : "bg-black/5 text-neutral-400 dark:bg-white/5",
          )}
        >
          {syncLabel}
        </span>
      )}
    </div>
  );
}
