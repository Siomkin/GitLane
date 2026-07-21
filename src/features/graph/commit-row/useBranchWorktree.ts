import { useMemo } from "react";
import { useRepo } from "@/store/repo";
import { findOtherBranchWorktree } from "@/lib/graphActions";
import { worktreeName } from "@/lib/worktrees";

/** The worktree a branch pill points at, when it isn't the open one. */
export interface BranchWorktreeRef {
  /** Disambiguated directory label (see {@link worktreeName}). */
  name: string;
  /** That worktree holds uncommitted work — the pill trails an amber dot.
   * Best-effort: false until the probe lands (see `repoWorktreeDirty.ts`). */
  dirty: boolean;
}

/** The worktree a local branch is checked out in (when it isn't the open one),
 * so its pill can show the worktree glyph — plus whether that worktree has
 * uncommitted work, so the pill can also show the dirty dot. Disambiguated
 * against sibling worktrees (see {@link worktreeName}) — agent tools nest every
 * worktree under `<id>/<repo>`, so the raw leaf ("GitLane") names nothing.
 *
 * The selector returns a JSON primitive (parsed once per change, as
 * `useDetachedWorktreesAt` does) so a pill re-renders only when its own worktree
 * binding or dirtiness actually moves — a fresh object straight out of the
 * selector would re-render it on every unrelated store write. */
export function useBranchWorktree(branch: string, enabled: boolean): BranchWorktreeRef | null {
  const json = useRepo((s) => {
    if (!enabled) return "";
    const ref = findOtherBranchWorktree(s.worktrees, branch, s.summary?.workdir ?? s.summary?.path ?? "");
    const wt = ref && s.worktrees.find((candidate) => candidate.path === ref.path);
    if (!wt) return "";
    return JSON.stringify({
      name: worktreeName(wt, s.worktrees),
      dirty: s.dirtyWorktrees.includes(wt.path),
    } satisfies BranchWorktreeRef);
  });
  return useMemo(() => (json === "" ? null : (JSON.parse(json) as BranchWorktreeRef)), [json]);
}
