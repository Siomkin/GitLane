/** The "this worktree has uncommitted work" dot, trailing the name on a ref pill
 * whose branch lives in another worktree and on a detached worktree pill.
 *
 * Amber, matching the WIP row's badge: the graph already says "uncommitted work"
 * in that colour for the open worktree, so a sibling worktree's unsaved work
 * reads as the same fact seen from outside rather than a new vocabulary. It is a
 * dot rather than a WIP badge because it must fit inside a pill without pushing
 * the branch name out — glanceable, not readable.
 *
 * Hidden from assistive tech: every pill that renders it already ends its own
 * title/aria-label with "— uncommitted changes", so labelling the dot too would
 * announce the same fact twice. The `title` stays for pointer users, who get no
 * such sentence unless they hover the pill itself. */
export function WorktreeDirtyDot() {
  return (
    <span
      aria-hidden="true"
      data-dirty-dot
      title="Uncommitted changes in this worktree"
      className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-300"
    />
  );
}
