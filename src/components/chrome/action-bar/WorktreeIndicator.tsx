import { cn } from "../../../lib/cn";
import { focusRing } from "../../../lib/ui";
import { worktreeIndicatorView } from "../../../lib/worktrees";
import { useRepo } from "../../../store/repo";
import { useUi } from "../../../store/ui";
import { TreeIcon } from "../../ui/icons";

/** Toolbar chip that flags when the open repo is itself a linked worktree
 * (GL-22): an accent chip naming that checkout, with its absolute path in the
 * tooltip — the "you are here, not in the main checkout" signal. A click opens
 * the branch/worktree navigator, where the Worktrees section lists and switches
 * between them. When the main worktree is open there's no chip — linked
 * worktrees still exist, but a permanent count badge would just sit in the
 * toolbar all the time; the navigator is where you discover them. */
export const WorktreeIndicator = ({ className }: { className?: string }) => {
  const summary = useRepo((s) => s.summary);
  const worktrees = useRepo((s) => s.worktrees);
  const openNav = useUi((s) => s.openNav);

  const view = worktreeIndicatorView(worktrees, summary);
  if (view.kind !== "active") return null;

  return (
    <button
      type="button"
      onClick={openNav}
      title={`Current worktree: ${view.name} · ${view.path}`}
      aria-label={`Current worktree ${view.name}. Show worktrees`}
      className={cn(
        "flex h-8 flex-none items-center gap-1.5 rounded-lg border px-2 text-[12.5px] font-medium",
        "border-[color:var(--accent)]/30 bg-[var(--accent-soft)] text-[color:var(--accent)]",
        focusRing,
        className,
      )}
    >
      <TreeIcon className="h-3.5 w-3.5 shrink-0" />
      <span className="max-w-[140px] truncate">{view.name}</span>
    </button>
  );
};
