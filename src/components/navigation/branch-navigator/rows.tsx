import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import type { BranchSyncState, StashEntry } from "@/lib/api";
import { syncBadgeLabel, syncTitle } from "@/lib/branchSync";
import { useUi } from "@/store/ui";
import { useTruncatedTooltip } from "@/components/chrome/overlays";
import { HighlightMatch } from "@/components/ui/HighlightMatch";
import { FolderIcon, MoreVerticalIcon, StashIcon, TreeIcon } from "@/components/ui/icons";
import type { RowKind } from "./refs";
import type { WorktreeItem } from "./useNavigatorSections";
import { useBranchRefDrag } from "@/hooks/useBranchRefDrag";
import { useOpenWorktree, useRevealNavigate, useRevealStashNavigate } from "./useRowActions";

/** A labelled section (Local / Remotes / Tags / Worktrees / Stashes). */
export function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="flex h-6 items-center px-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">{label}</span>
      </div>
      {children}
    </div>
  );
}

const ROW_CLASS =
  "flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-[13px] text-neutral-600 transition-opacity hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5";

// Kept for callers that want to de-emphasize rows outside another context. The
// branch navigator search itself filters non-matches out of the popup.
const DIM_CLASS = "opacity-25 hover:opacity-100";

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
  const draggable = kind !== "tag";
  const syncLabel = kind === "local" ? syncBadgeLabel(sync) : null;
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
      className={cn(
        "flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-[13px] transition-opacity",
        isCurrent
          ? "bg-[var(--accent-soft)] font-medium text-[color:var(--accent)]"
          : kind === "remote"
            ? "text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
            : "text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5",
        dimmed && DIM_CLASS,
      )}
      style={{ boxShadow: isDropTarget ? "inset 0 0 0 1.5px rgba(46,158,98,0.7)" : undefined }}
      onClick={() => navigate(oid)}
      onContextMenu={(e) => {
        e.preventDefault();
        // Tags are immutable pointers — they get their own menu (checkout /
        // branch / worktree / copy) keyed off the tagged commit oid.
        if (kind === "tag") {
          if (oid) openTagMenu({ x: e.clientX, y: e.clientY, name, sha: oid });
          return;
        }
        openContextMenu({ x: e.clientX, y: e.clientY, branch: name, isCurrent });
      }}
    >
      {worktree && !isCurrent ? (
        // A branch parked in a worktree gets the worktree glyph (in accent) in
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

/** A worktree row — two lines so sibling worktrees are distinguishable: the
 * checked-out branch (or directory name when detached) over its absolute path.
 * Left-click is the primary action: switch the app to that worktree (it loads as
 * the open repo). The already-open ("current") worktree can't be switched to, so
 * its click just scrolls the graph to its tip. The trailing kebab (⋮) — and the
 * equivalent right-click — open the worktree menu (open / copy path / remove), so
 * removal isn't hidden behind a right-click only (GL-61). The leading badges
 * separate current / main / linked. */
export function WorktreeRow({
  wt,
  oid,
  isActive,
  label,
  dimmed = false,
  query = "",
}: Omit<WorktreeItem, "match"> & { dimmed?: boolean; query?: string }) {
  const reveal = useRevealNavigate();
  const open = useOpenWorktree();
  const openWorktreeMenu = useUi((s) => s.openWorktreeMenu);
  const tip = useTruncatedTooltip(label);
  // Primary action: switch to the worktree — in place by default; cmd/ctrl
  // opens it in a new tab (GL-110). The already-open one can't be switched to,
  // so it just scrolls the graph to its tip.
  const activate = (newTab = false) => (isActive ? reveal(oid) : open(wt.path, newTab));
  // The kebab and right-click share one entry point — same menu, same payload.
  const openMenu = (x: number, y: number) =>
    openWorktreeMenu({ x, y, path: wt.path, name: label, isMain: wt.isMain });
  return (
    <div
      {...tip}
      role="button"
      tabIndex={0}
      aria-label={isActive ? `Current worktree ${label}` : `Open worktree ${label}`}
      className={cn(
        "group flex min-h-[2.75rem] cursor-pointer flex-col justify-center gap-0.5 rounded-lg px-2 py-1 text-[13px] transition-opacity",
        isActive
          ? "bg-[var(--accent-soft)] font-medium text-[color:var(--accent)]"
          : "text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5",
        dimmed && DIM_CLASS,
      )}
      onClick={(e) => activate(e.metaKey || e.ctrlKey)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate(e.metaKey || e.ctrlKey);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY);
      }}
    >
      <div className="flex items-center gap-2">
        <TreeIcon className={cn("h-3.5 w-3.5 shrink-0", !isActive && "text-neutral-400")} />
        <span data-truncate className="min-w-0 flex-1 truncate">
          <HighlightMatch text={label} query={query} />
        </span>
        {isActive && <span className="shrink-0 text-[10px] font-medium">current</span>}
        {wt.isMain && <span className="shrink-0 text-[10px] font-medium text-neutral-400">main</span>}
        {!isActive && (
          // Make the left-click action explicit: a faint open glyph that lights
          // up on hover/focus signals the row switches to the worktree.
          <FolderIcon
            aria-hidden
            className="h-3.5 w-3.5 shrink-0 text-neutral-400 opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100"
          />
        )}
        {/* Visible affordance for the worktree menu (open / copy path / remove)
            so those actions aren't reachable by right-click alone. Stops the
            row's activate (switch-to-worktree) click/keys from also firing. */}
        <button
          type="button"
          aria-haspopup="menu"
          aria-label={`Worktree actions for ${label}`}
          className={cn(
            "-mr-1 grid h-6 w-6 shrink-0 place-items-center rounded-md text-neutral-400 transition hover:bg-black/10 hover:text-neutral-600 dark:hover:bg-white/10 dark:hover:text-neutral-200",
            focusRing,
          )}
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(r.left, r.bottom + 4);
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <MoreVerticalIcon className="h-4 w-4" />
        </button>
      </div>
      {/* Absolute path as secondary text (+ full path on hover) so sibling
          worktrees that share a branch-less label stay distinguishable. */}
      <div className="truncate pl-[1.375rem] text-[11px] font-normal text-neutral-400" title={wt.path}>
        {wt.path}
      </div>
    </div>
  );
}

/** A stash row — click jumps to its graph row; right-click for apply/pop/drop. */
export function StashRow({
  stash,
  dimmed = false,
  query = "",
}: {
  stash: StashEntry;
  dimmed?: boolean;
  query?: string;
}) {
  const navigate = useRevealStashNavigate();
  const openStashMenu = useUi((s) => s.openStashMenu);
  const tip = useTruncatedTooltip(stash.message);
  return (
    <div
      {...tip}
      className={cn(ROW_CLASS, dimmed && DIM_CLASS)}
      onClick={() => navigate(stash.oid)}
      onContextMenu={(e) => {
        e.preventDefault();
        openStashMenu({ x: e.clientX, y: e.clientY, index: stash.index, message: stash.message });
      }}
    >
      <StashIcon className="h-3.5 w-3.5 shrink-0 text-amber-500" />
      <span data-truncate className="min-w-0 flex-1 truncate">
        <HighlightMatch text={stash.message} query={query} />
      </span>
      <span className="shrink-0 font-mono text-[10px] text-neutral-400">{`{${stash.index}}`}</span>
    </div>
  );
}

/** The leading glyph: a check for the checked-out branch, otherwise a kind-specific
 * monochrome icon (branch fork / cloud / tag), matching the design. */
function RowGlyph({ kind, current }: { kind: RowKind; current: boolean }) {
  if (current) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 shrink-0">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  }
  if (kind === "remote") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5 shrink-0 text-neutral-400">
        <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.34 9.5 4 4 0 0 0 7 17.5" />
      </svg>
    );
  }
  if (kind === "tag") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5 shrink-0 text-neutral-400">
        <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
        <circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5 shrink-0 text-neutral-400">
      <path d="M6 3v15M18 9a9 9 0 0 1-9 9" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
    </svg>
  );
}
