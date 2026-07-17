import { useRepo } from "@/store/repo";
import { findOtherBranchWorktree } from "@/lib/graphActions";
import { worktreeName } from "@/lib/worktrees";

/** Name of the worktree a local branch is checked out in (when it isn't the
 * open one), so its pill can show the worktree glyph. Disambiguated against
 * sibling worktrees (see {@link worktreeName}) — agent tools nest every
 * worktree under `<id>/<repo>`, so the raw leaf ("GitLane") names nothing.
 * Returns a primitive so the selector only re-renders this pill when its own
 * worktree binding changes. */
export function useBranchWorktreeName(branch: string, enabled: boolean): string | null {
  return useRepo((s) => {
    if (!enabled) return null;
    const ref = findOtherBranchWorktree(s.worktrees, branch, s.summary?.workdir ?? s.summary?.path ?? "");
    const wt = ref && s.worktrees.find((candidate) => candidate.path === ref.path);
    return wt ? worktreeName(wt, s.worktrees) : null;
  });
}
