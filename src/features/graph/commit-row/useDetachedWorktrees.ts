import { useMemo } from "react";
import { useRepo } from "@/store/repo";
import { isActiveWorktreePath, worktreeName } from "@/lib/worktrees";

/** A detached worktree parked on a commit, for the row's worktree pill. */
export interface DetachedWorktreeAt {
  /** Distinguishing directory label (see {@link worktreeName}). */
  name: string;
  path: string;
  isMain: boolean;
}

/** Detached worktrees (checked out to a commit, no branch) whose HEAD sits on
 * this commit. A branch checked out elsewhere already surfaces via its branch
 * pill's worktree glyph, but a detached worktree has no ref at all — without
 * this it is invisible in the graph. The *open* worktree is excluded (matching
 * the branch glyphs' other-worktree-only rule): its detached HEAD already
 * surfaces through the graph's own HEAD marker, so a pill would duplicate it.
 * The selector returns a JSON primitive so a row only re-renders when its own
 * worktree set actually changes. */
export function useDetachedWorktreesAt(commitId: string): DetachedWorktreeAt[] {
  const json = useRepo((s) => {
    const entries = s.worktrees
      .filter(
        (wt) =>
          !wt.branch &&
          !wt.bare &&
          !wt.prunable &&
          wt.head === commitId &&
          !isActiveWorktreePath(s.summary, wt.path),
      )
      .map((wt) => ({ name: worktreeName(wt, s.worktrees), path: wt.path, isMain: wt.isMain }));
    return entries.length > 0 ? JSON.stringify(entries) : "";
  });
  return useMemo(() => (json === "" ? [] : (JSON.parse(json) as DetachedWorktreeAt[])), [json]);
}
