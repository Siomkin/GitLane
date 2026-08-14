import { startWorktreeHandoff } from "@/lib/worktreeHandoff";
import { TreeIcon } from "@/components/ui/icons";
import { type MenuItem } from "@/components/chrome/overlays/shared";
import type { BranchMenuContext } from "./context";

// ---- worktree (branch-only): a branch checked out in a linked worktree shows
// as a branch pill with no separate worktree pill, so the worktree-management
// actions — reclaim the branch here, copy its path, hand off, remove — are
// grouped here (Open worktree stays promoted on top as the one-click). ----
export function worktreeItems(ctx: BranchMenuContext): MenuItem[] {
  const {
    b,
    close,
    worktrees,
    existingWorktree: existingWt,
    existingWorktreeInfo: existingWtInfo,
    handoffHere,
    canHandOff,
    canRemoveWorktree,
    openHandoff,
    showToast,
    requestRemoveWorktree,
  } = ctx;

  const worktree: MenuItem[] = [];
  if (existingWt) {
    const children: MenuItem[] = [];
    // The escape hatch: git refuses to check out a branch another worktree holds,
    // so plain Checkout is hidden — but the branch can be *moved* here (detach it
    // there, check it out here) via the hand-off dialog with the open worktree
    // preselected. A prunable holder can't run the detach step (no dead click).
    if (handoffHere) {
      children.push({
        label: "Check out here…",
        onClick: () =>
          startWorktreeHandoff({
            branch: b,
            sourcePath: existingWt.path,
            worktrees,
            sourceChanges: null,
            destPath: handoffHere.value,
            openHandoff,
            onNoDestinations: () => showToast("No worktree to check out into.", "error"),
          }),
      });
    }
    children.push({ label: "Copy worktree path", onClick: () => { close(); void navigator.clipboard?.writeText(existingWt.path); } });
    // Hand off eligibility is derived in the pure policy (source valid + a real
    // destination exists), keeping the menu component a dumb painter.
    if (canHandOff) {
      children.push({
        label: "Hand off to…",
        onClick: () =>
          startWorktreeHandoff({
            branch: b,
            sourcePath: existingWt.path,
            worktrees,
            sourceChanges: null,
            openHandoff,
            onNoDestinations: () => showToast("No other worktree to hand off to.", "error"),
          }),
      });
    }
    // Git refuses to remove the main worktree; the policy offers Remove for linked ones only.
    if (canRemoveWorktree) {
      children.push({
        label: "Remove worktree",
        danger: true,
        // Shares the worktree row menu's probe-then-confirm so a dirty worktree
        // is warned about and force-removed on confirm (GL-296).
        onClick: () => void requestRemoveWorktree({ name: existingWtInfo?.name ?? existingWt.path, path: existingWt.path, branch: b, head: existingWtInfo?.head ?? null, locked: existingWtInfo?.locked ?? false }),
      });
    }
    worktree.push({ label: "Worktree", icon: <TreeIcon className="h-4 w-4 text-[color:var(--accent)]" />, note: existingWt.path, submenu: children });
  }
  return worktree;
}
