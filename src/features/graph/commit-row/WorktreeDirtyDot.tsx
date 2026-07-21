/** The "this worktree has uncommitted work" dot, trailing the name on a ref pill
 * whose branch lives in another worktree and on a detached worktree pill.
 *
 * Amber, matching the WIP row's badge: the graph already says "uncommitted work"
 * in that colour for the open worktree, so a sibling worktree's unsaved work
 * reads as the same fact seen from outside rather than a new vocabulary. It is a
 * dot rather than a WIP badge because it must fit inside a pill without pushing
 * the branch name out — glanceable, not readable.
 *
 * `title` carries the meaning for anyone who can't infer it from a 6px dot; the
 * pills also fold it into their own tooltip. */
export function WorktreeDirtyDot() {
  return (
    <span
      role="img"
      aria-label="Uncommitted changes in this worktree"
      title="Uncommitted changes in this worktree"
      className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-300"
    />
  );
}
