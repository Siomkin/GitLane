import type { ReactNode } from "react";

/** The group heading in the navigator's "All" view (Branches / Remotes /
 * Worktrees / Tags / Stashes), with the number of rows shown beneath it.
 *
 * It renders as a standalone row, not a wrapper around its rows: the list is
 * virtualized, so headers and rows are siblings in one flat sequence and only
 * the visible slice is mounted. `action` is an optional right-aligned control
 * (the Worktrees group's "Remove detached" sweep). */
export function SectionHeader({
  label,
  count,
  action,
}: {
  label: string;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-7 items-center gap-1.5 px-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">{label}</span>
      {count !== undefined && (
        <span className="text-[10px] font-semibold text-neutral-300 dark:text-neutral-500">{count}</span>
      )}
      <span className="ml-auto flex items-center">{action}</span>
    </div>
  );
}
