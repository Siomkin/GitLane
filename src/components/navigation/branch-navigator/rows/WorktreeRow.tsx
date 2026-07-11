import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { useUi } from "@/store/ui";
import { useTruncatedTooltip } from "@/components/chrome/overlays";
import { HighlightMatch } from "@/components/ui/HighlightMatch";
import { FolderIcon, MoreVerticalIcon, TreeIcon } from "@/components/ui/icons";
import type { WorktreeItem } from "../useNavigatorSections";
import { useOpenWorktree, useRevealNavigate } from "../useRowActions";
import { DIM_CLASS } from "./rowStyles";

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
