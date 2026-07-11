import type { RefLabel } from "../../../lib/api";
import { cn } from "../../../lib/cn";
import { remoteTrackingCheckoutCandidate } from "@/lib/remoteBranches";
import { TreeIcon } from "../../../components/ui/icons";
import { useRepo } from "../../../store/repo";
import { useUi } from "../../../store/ui";
import { useBranchRefDrag } from "../../../hooks/useBranchRefDrag";
import { useBranchWorktreeName } from "./useBranchWorktreeName";

export function RefPill({ refLabel, current, targetSha }: { refLabel: RefLabel; current: boolean; targetSha: string }) {
  const openContextMenu = useUi((state) => state.openContextMenu);
  const openTagMenu = useUi((state) => state.openTagMenu);
  const checkoutBranch = useRepo((state) => state.checkoutBranch);
  const checkoutRemoteBranch = useRepo((state) => state.checkoutRemoteBranch);
  const worktreeName = useBranchWorktreeName(refLabel.name, refLabel.kind === "branch" && !current);
  const draggable = refLabel.kind === "branch" || refLabel.kind === "remote";
  const name = refLabel.name;
  // The pill is nested in a droppable commit row, so stop drag events bubbling.
  const { isDropTarget, dndProps } = useBranchRefDrag(
    name,
    draggable
      ? {
          draggable: true,
          kind: refLabel.kind === "branch" ? "local" : "remote",
          // Local branches and remote-tracking refs are both drop targets:
          // dropping onto a remote ref moves the dragged local branch onto it
          // (e.g. fast-forward develop → origin/develop).
          droppable: true,
          stopPropagation: true,
        }
      : { draggable: false, stopPropagation: true },
  );

  const base =
    "flex items-center gap-1 h-[22px] rounded-md text-[11px] font-medium whitespace-nowrap shrink-0 select-none max-w-[220px]";
  const style = current
    ? "pl-1 pr-2 bg-[var(--accent)] text-white shadow-sm cursor-grab active:cursor-grabbing"
    : refLabel.kind === "tag"
      ? "pl-1.5 pr-2 bg-amber-50 dark:bg-amber-400/10 border border-amber-300/70 dark:border-amber-400/25 text-amber-700 dark:text-amber-300"
      : refLabel.kind === "remote"
        ? "pl-1.5 pr-2 bg-black/[0.04] dark:bg-white/[0.05] border border-black/[0.06] dark:border-white/[0.06] text-neutral-500 dark:text-neutral-400 cursor-grab active:cursor-grabbing"
        : "pl-1.5 pr-2 bg-white dark:bg-neutral-700 border border-black/10 dark:border-white/10 text-neutral-700 dark:text-neutral-200 shadow-sm cursor-grab active:cursor-grabbing";

  const icon = current ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3 w-3 shrink-0">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ) : refLabel.kind === "tag" ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3 w-3 shrink-0">
      <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
      <circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" />
    </svg>
  ) : refLabel.kind === "remote" ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3 w-3 shrink-0">
      <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.34 9.5 4 4 0 0 0 7 17.5" />
    </svg>
  ) : worktreeName ? (
    // Checked out in another worktree → the worktree glyph instead of the plain
    // branch fork. Neutral (not accent): accent is reserved for the *active*
    // worktree, and this branch lives in a non-active one.
    <TreeIcon className="h-3 w-3 shrink-0 text-neutral-400" />
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3 w-3 shrink-0 text-neutral-400">
      <path d="M6 3v15M18 9a9 9 0 0 1-9 9" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
    </svg>
  );

  return (
    <span
      {...dndProps}
      className={cn(base, style)}
      title={worktreeName ? `Checked out in worktree: ${worktreeName}` : undefined}
      style={isDropTarget ? { boxShadow: "inset 0 0 0 1.5px rgba(46,158,98,0.75)" } : undefined}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        if (!draggable) return;
        e.stopPropagation();
        if (refLabel.kind === "remote") {
          const remoteCheckout = remoteTrackingCheckoutCandidate(name, useRepo.getState().branches);
          if (remoteCheckout) {
            void checkoutRemoteBranch(remoteCheckout.remote, remoteCheckout.branch).catch((err) =>
              useUi.getState().showToast(String(err), "error"),
            );
            return;
          }
        }
        void checkoutBranch(name).catch((err) =>
          useUi.getState().showToast(String(err), "error"),
        );
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (refLabel.kind === "tag") {
          openTagMenu({ x: e.clientX, y: e.clientY, name, sha: targetSha });
          return;
        }
        if (!draggable) return;
        openContextMenu({ x: e.clientX, y: e.clientY, branch: name, isCurrent: current });
      }}
    >
      {icon}
      <span className="truncate">{name}</span>
    </span>
  );
}
