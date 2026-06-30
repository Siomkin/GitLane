import { cn } from "../../../lib/cn";
import { focusRing } from "../../../lib/ui";
import { worktreeIndicatorView } from "../../../lib/worktrees";
import { useRepo } from "../../../store/repo";
import { useUi } from "../../../store/ui";
import { ArrowLeftIcon, TreeIcon } from "../../ui/icons";

/** Toolbar cluster shown only when the open repo is itself a linked worktree
 * (GL-22) — the "you are here, not in the main checkout" signal:
 *
 * - A back button that switches straight back to the main checkout (your primary
 *   work), so leaving a scratch/linked worktree is one click, not a trip through
 *   the navigator.
 * - An accent tree-icon chip. Its worktree name + absolute path live in the
 *   tooltip and accessible label (the branch trigger to its left already shows
 *   the ref, so the name isn't repeated inline). A click opens the
 *   branch/worktree navigator, where every worktree is listed and switchable.
 *
 * When the main worktree is open there's no cluster — linked worktrees still
 * exist, but a permanent badge would just sit in the toolbar all the time; the
 * navigator is where you discover them. */
export const WorktreeIndicator = ({ className }: { className?: string }) => {
  const summary = useRepo((s) => s.summary);
  const worktrees = useRepo((s) => s.worktrees);
  const openWorktree = useRepo((s) => s.openWorktree);
  const openNav = useUi((s) => s.openNav);
  const showToast = useUi((s) => s.showToast);

  const view = worktreeIndicatorView(worktrees, summary);
  if (view.kind !== "active") return null;

  // git always lists the main worktree first and flags it; it's the "back to
  // current work" target. Guarded in case the list hasn't loaded it yet.
  const mainWt = worktrees.find((w) => w.isMain) ?? null;
  const backToMain = () => {
    if (!mainWt) return;
    void openWorktree(mainWt.path).catch((e) => showToast(String(e), "error"));
  };

  return (
    <div className={cn("flex flex-none items-center gap-1", className)}>
      {mainWt && (
        <button
          type="button"
          onClick={backToMain}
          title={`Back to main checkout · ${mainWt.path}`}
          aria-label="Back to main checkout"
          className={cn(
            "grid h-8 w-8 place-items-center rounded-lg border text-neutral-500",
            "border-black/10 bg-white/40 hover:bg-white/70 dark:border-white/10 dark:bg-white/[0.03] dark:text-neutral-300 dark:hover:bg-white/[0.06]",
            focusRing,
          )}
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
      )}
      <button
        type="button"
        onClick={openNav}
        title={`Current worktree: ${view.name} · ${view.path}`}
        aria-label={`Current worktree ${view.name}. Show worktrees`}
        className={cn(
          "grid h-8 w-8 place-items-center rounded-lg border",
          "border-[color:var(--accent)]/30 bg-[var(--accent-soft)] text-[color:var(--accent)]",
          focusRing,
        )}
      >
        <TreeIcon className="h-4 w-4 shrink-0" />
      </button>
    </div>
  );
};
