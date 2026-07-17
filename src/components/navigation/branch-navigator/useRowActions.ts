import type { WorktreeInfo } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";

/** Jump the graph to a ref's tip (scroll + history-tab flip via `revealCommit`)
 * and close the navigator. Shared by branch/remote/tag and worktree rows. */
export function useRevealNavigate() {
  const revealCommit = useRepo((s) => s.revealCommit);
  const closeNav = useUi((s) => s.closeNav);
  return (oid?: string) => {
    if (oid) void revealCommit(oid);
    closeNav();
  };
}

/** Bulk-remove every removable detached worktree — the Worktrees section-header
 * sweep. Opens the dedicated RemoveDetachedDialog (destructive confirm → live
 * per-worktree checklist → summary) rather than a fire-and-forget toast, so the
 * removal shows progress like the hand-off / delete-worktree flows. Closes the
 * navigator first — the dialog is a full-screen modal that outlives the popup. */
export function useRemoveDetachedWorktrees(targets: WorktreeInfo[]) {
  const openRemoveDetached = useUi((s) => s.openRemoveDetached);
  const closeNav = useUi((s) => s.closeNav);
  return () => {
    if (targets.length === 0) return;
    closeNav();
    openRemoveDetached({ targets });
  };
}

/** Jump the graph to a stash row without selecting its file list in the right
 * inspector. Right-click actions stay on the stash row itself. */
export function useRevealStashNavigate() {
  const revealStash = useRepo((s) => s.revealStash);
  const closeNav = useUi((s) => s.closeNav);
  return (oid: string) => {
    revealStash(oid);
    closeNav();
  };
}
