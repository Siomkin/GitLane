import { cn } from "../../../lib/cn";
import { focusRing } from "../../../lib/ui";
import { worktreeIndicatorView } from "../../../lib/worktrees";
import { useRepo } from "../../../store/repo";
import { useUi } from "../../../store/ui";
import { handoffDestinationOptions, startWorktreeHandoff } from "../../../lib/worktreeHandoff";
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
  const changes = useRepo((s) => s.changes);
  const openWorktree = useRepo((s) => s.openWorktree);
  const openNav = useUi((s) => s.openNav);
  const openHandoff = useUi((s) => s.openHandoff);
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

  // Hand this worktree's branch (and its uncommitted work) off to another
  // workspace (GL-74) — the reverse of "back to main" when you want the branch,
  // not yourself, to move. Only when a branch is checked out and there's a
  // destination. `view.path` is this (active) worktree; it's the open repo, so
  // its change count is known.
  const branch = summary?.headBranch ?? null;
  // Only show the affordance when a valid destination actually exists (bare /
  // prunable worktrees are filtered out), so it's never a dead click.
  const canHandoff = !!branch && handoffDestinationOptions(worktrees, view.path).length > 0;
  const handoff = () => {
    if (!branch) return;
    startWorktreeHandoff({
      branch,
      sourcePath: view.path,
      worktrees,
      sourceChanges:
        changes.staged.length + changes.unstaged.length + changes.conflicted.length,
      openHandoff,
      onNoDestinations: () => showToast("No other worktree to hand off to.", "error"),
    });
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
      {canHandoff && (
        <button
          type="button"
          onClick={handoff}
          title={`Hand off ${branch} to another workspace`}
          aria-label={`Hand off ${branch} to another workspace`}
          className={cn(
            "grid h-8 w-8 place-items-center rounded-lg border text-neutral-500",
            "border-black/10 bg-white/40 hover:bg-white/70 dark:border-white/10 dark:bg-white/[0.03] dark:text-neutral-300 dark:hover:bg-white/[0.06]",
            focusRing,
          )}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
          >
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
            <path d="M10 17l5-5-5-5" />
            <path d="M15 12H3" />
          </svg>
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
