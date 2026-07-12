import { useRepo } from "@/store/repo";
import { findOtherBranchWorktree } from "@/lib/graphActions";

/** Name of the worktree a local branch is checked out in (when it isn't the
 * open one), so its pill can show the worktree glyph. Returns a primitive so the
 * selector only re-renders this pill when its own worktree binding changes. */
export function useBranchWorktreeName(branch: string, enabled: boolean): string | null {
  return useRepo((s) => {
    if (!enabled) return null;
    const wt = findOtherBranchWorktree(s.worktrees, branch, s.summary?.workdir ?? s.summary?.path ?? "");
    return wt ? (wt.path.replace(/\/+$/, "").split("/").pop() ?? null) : null;
  });
}
