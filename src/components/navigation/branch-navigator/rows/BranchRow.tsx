import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import type { BranchSyncState } from "@/lib/api";
import { syncBadgeLabel, syncTitle } from "@/lib/branchSync";
import { useUi } from "@/store/ui";
import { useTruncatedTooltip } from "@/components/chrome/overlays";
import { HighlightMatch } from "@/components/ui/HighlightMatch";
import { PinFilledIcon, PinIcon, TreeIcon } from "@/components/ui/icons";
import { pinKey, RowKind } from "@/components/navigation/branch-navigator/refs";
import { useBranchRefDrag } from "@/hooks/useBranchRefDrag";
import { useRevealNavigate } from "@/components/navigation/branch-navigator/useRowActions";
import { RowGlyph } from "./RowGlyph";
import { DIM_CLASS } from "./rowStyles";

/** A branch / remote / tag row. Click jumps the graph to its tip and closes the
 * popup; checkout lives on the right-click context menu (single-click closes the
 * popup, so a double-click gesture here can't land reliably). Tags aren't drag
 * sources, but they do get a tag-specific right-click menu. Hovering swaps the
 * leading glyph for a pin toggle — pinned rows sort to the top of the section.
 *
 * Structure: a presentational wrapper holding two SIBLING controls — the row
 * itself (reveal + drag source/target + context menu) and the pin button
 * layered over the glyph slot. The pin used to sit inside the row, which nested
 * a real button inside `role="button"`; siblings keep each control's semantics
 * its own. The two are separate tab stops, as two independent actions should be. */
export function BranchRow({
  name,
  kind,
  oid,
  refOid,
  isCurrent = false,
  pinned = false,
  dimmed = false,
  query = "",
  sync = null,
  worktree = null,
}: {
  name: string;
  kind: RowKind;
  oid?: string;
  /** Exact object named by a tag ref; distinct from peeled commit `oid`. */
  refOid?: string;
  isCurrent?: boolean;
  /** Pinned to the top of its section (the hover pin toggle's state). */
  pinned?: boolean;
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
  const toggleNavPin = useUi((s) => s.toggleNavPin);
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
    // Presentational wrapper: it owns the row's shape, background and hover
    // state so the reveal control and the pin can be SIBLINGS rather than the
    // pin being nested inside an element with role="button" (which reads as a
    // button inside a button). It carries the hover background because the pin
    // is layered over the reveal control and is no longer its descendant, so
    // hovering the pin would otherwise drop the row's own :hover.
    <div
      className={cn(
        "group relative rounded-lg transition-opacity",
        isCurrent
          ? "bg-[var(--accent-soft)]"
          : "hover:bg-black/5 dark:hover:bg-white/5",
        dimmed && DIM_CLASS,
      )}
      style={{ boxShadow: isDropTarget ? "inset 0 0 0 1.5px rgba(46,158,98,0.7)" : undefined }}
    >
      <div
        {...tip}
        {...dndProps}
        role="button"
        tabIndex={0}
        aria-label={isCurrent ? `Current ${kind} ${name}` : `Reveal ${kind} ${name}`}
        className={cn(
          "flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-[13px]",
          focusRing,
          isCurrent
            ? "font-medium text-[color:var(--accent)]"
            : kind === RowKind.Remote
              ? "text-neutral-500 dark:text-neutral-400"
              : "text-neutral-600 dark:text-neutral-300",
        )}
        onClick={() => navigate(oid)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            navigate(oid);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          // Tags get their own menu (checkout / branch / worktree / copy), with
          // both the peeled commit and exact tag-ref target captured.
          if (kind === RowKind.Tag) {
            if (oid) {
              openTagMenu({ x: e.clientX, y: e.clientY, name, sha: oid, refOid: refOid ?? oid });
            }
            return;
          }
          openContextMenu({ x: e.clientX, y: e.clientY, branch: name, isCurrent });
        }}
      >
        {/* Fades out under the pin on hover (per the design), leaving the pin
            as the visible control in this slot. */}
        <span className="grid h-3.5 w-3.5 shrink-0 place-items-center transition-opacity group-hover:opacity-0">
          {worktree && !isCurrent ? (
            // A branch parked in a worktree gets the neutral worktree glyph in
            // place of the branch fork — the same icon as the Worktrees section,
            // so the two read as the same thing. The tooltip names which worktree.
            <span
              title={`Checked out in worktree: ${worktree}`}
              aria-label={`Checked out in worktree ${worktree}`}
              className="text-neutral-400"
            >
              <TreeIcon className="h-3.5 w-3.5" />
            </span>
          ) : (
            <RowGlyph kind={kind} current={isCurrent} />
          )}
        </span>
        <span data-truncate className="min-w-0 flex-1 truncate">
          <HighlightMatch text={name} query={query} />
        </span>
        {isCurrent && <span className="shrink-0 text-[10.5px] text-neutral-400">current</span>}
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
      {/* Sibling of the reveal control, layered over the glyph slot it replaces
          on hover. Being outside the row means no nested interactive, and a
          drag starting here can't reach the row's drag handlers at all.
          `pointer-events-none` until hover/focus keeps the invisible pin from
          swallowing clicks aimed at the glyph where hover never fires. */}
      <button
        type="button"
        draggable={false}
        title={pinned ? "Unpin" : "Pin to top"}
        aria-label={pinned ? `Unpin ${name}` : `Pin ${name} to top`}
        aria-pressed={pinned}
        className={cn(
          "absolute left-2 top-1/2 grid h-3.5 w-3.5 -translate-y-1/2 place-items-center rounded",
          "pointer-events-none opacity-0 transition-opacity",
          "focus-visible:pointer-events-auto focus-visible:opacity-100",
          "group-hover:pointer-events-auto group-hover:opacity-100",
          pinned ? "text-[color:var(--accent)]" : "text-neutral-400 hover:text-[color:var(--accent)]",
        )}
        onClick={() => toggleNavPin(pinKey(kind, name))}
      >
        {pinned ? <PinFilledIcon className="h-3.5 w-3.5" /> : <PinIcon className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
