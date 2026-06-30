import { cn } from "../../../lib/cn";
import { focusRing } from "../../../lib/ui";
import { worktreeIndicatorView } from "../../../lib/worktrees";
import { useRepo } from "../../../store/repo";
import { useUi } from "../../../store/ui";
import { TreeIcon } from "../../ui/icons";

/** Toolbar chip that surfaces linked worktrees from the main app surface (GL-22):
 * the branch dropdown used to be the only place they appeared. Two states:
 *  - the open repo IS a linked worktree → an accent chip naming that checkout,
 *    with its absolute path in the tooltip ("you are here");
 *  - the open repo isn't, but linked worktrees exist → a neutral chip with their
 *    count, so their existence is obvious without opening the dropdown.
 * Either way a click opens the branch/worktree navigator (anchored under the
 * branch trigger) where the Worktrees section lists and switches between them. */
export const WorktreeIndicator = ({ className }: { className?: string }) => {
  const summary = useRepo((s) => s.summary);
  const worktrees = useRepo((s) => s.worktrees);
  const openNav = useUi((s) => s.openNav);

  const view = worktreeIndicatorView(worktrees, summary);
  if (view.kind === "none") return null;

  const active = view.kind === "active";
  const label = active ? view.name : `${view.linkedCount}`;
  const title = active
    ? `Current worktree: ${view.name} · ${view.path}`
    : `${view.linkedCount} linked worktree${view.linkedCount === 1 ? "" : "s"} · click to view`;
  const aria = active
    ? `Current worktree ${view.name}. Show worktrees`
    : `${view.linkedCount} linked worktree${view.linkedCount === 1 ? "" : "s"}. Show worktrees`;

  return (
    <button
      type="button"
      onClick={openNav}
      title={title}
      aria-label={aria}
      className={cn(
        "flex h-8 flex-none items-center gap-1.5 rounded-lg border px-2 text-[12.5px] font-medium",
        active
          ? "border-[color:var(--accent)]/30 bg-[var(--accent-soft)] text-[color:var(--accent)]"
          : "border-black/10 bg-white/40 text-neutral-600 hover:bg-white/70 dark:border-white/10 dark:bg-white/[0.03] dark:text-neutral-300 dark:hover:bg-white/[0.06]",
        focusRing,
        className,
      )}
    >
      <TreeIcon className={cn("h-3.5 w-3.5 shrink-0", !active && "text-neutral-400")} />
      <span className="max-w-[140px] truncate">{label}</span>
    </button>
  );
};
