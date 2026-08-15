import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { isDetachedWorktree } from "@/lib/worktrees";
import { useUi, MenuKind } from "@/store/ui";
import { useTruncatedTooltip } from "@/components/chrome/overlays";
import { HighlightMatch } from "@/components/ui/HighlightMatch";
import { MoreVerticalIcon, TreeIcon } from "@/components/ui/icons";
import type { WorktreeItem } from "@/components/navigation/branch-navigator/useNavigatorSections";
import { useRevealNavigate } from "@/components/navigation/branch-navigator/useRowActions";
import { DIM_CLASS } from "./rowStyles";

/** A worktree row — two lines so sibling worktrees are distinguishable: the
 * checked-out branch (or directory name when detached) over its absolute path.
 * Left-click reveals the worktree's tip in the graph and highlights the row —
 * the same navigate-and-highlight behaviour as the branch / remote / tag rows,
 * so the whole navigator is consistent. Actually *switching* the app to the
 * worktree lives on the kebab (⋮) / right-click menu ("Open worktree" / "Open in
 * new tab"), alongside copy-path and remove (so removal isn't hidden behind a
 * right-click only — GL-61). The leading badges separate current / main /
 * detached. */
export function WorktreeRow({
  wt,
  oid,
  isActive,
  label,
  dimmed = false,
  query = "",
}: WorktreeItem & { dimmed?: boolean; query?: string }) {
  const reveal = useRevealNavigate();
  const openUiMenu = useUi((s) => s.openMenu);
  const tip = useTruncatedTooltip(label);
  // The kebab and right-click share one entry point — same menu, same payload.
  const openMenu = (x: number, y: number) =>
    openUiMenu({ kind: MenuKind.Worktree, state: { x, y, path: wt.path, name: label, isMain: wt.isMain } });
  return (
    <div
      {...tip}
      role="button"
      tabIndex={0}
      aria-label={isActive ? `Current worktree ${label}` : `Reveal worktree ${label}`}
      className={cn(
        "group flex min-h-[2.75rem] cursor-pointer flex-col justify-center gap-0.5 rounded-lg px-2 py-1 text-[13px] transition-opacity",
        isActive
          ? "bg-[var(--accent-soft)] font-medium text-[color:var(--accent)]"
          : "text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5",
        dimmed && DIM_CLASS,
      )}
      onClick={() => reveal(oid)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          reveal(oid);
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
        {isDetachedWorktree(wt) && (
          // No branch is checked out here — flag it, since the label falls back
          // to a directory name and otherwise reads like any other worktree.
          <span
            title="Detached HEAD — no branch checked out"
            className="shrink-0 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
          >
            detached
          </span>
        )}
        {/* Visible affordance for the worktree menu (open / copy path / remove)
            so those actions aren't reachable by right-click alone. Stops the
            row's reveal click/keys from also firing. */}
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
