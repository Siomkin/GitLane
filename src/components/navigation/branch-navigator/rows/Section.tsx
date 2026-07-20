import type { ReactNode } from "react";

/** A labelled section (Branches / Remotes / Worktrees / Tags / Stashes) in the
 * navigator's "All" view. `count` is the section's row count shown after the
 * label; `action` is an optional right-aligned header control (e.g. the
 * Worktrees section's "Remove detached" sweep). */
export function Section({
  label,
  count,
  action,
  children,
}: {
  label: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex h-7 items-center gap-1.5 px-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">{label}</span>
        {count !== undefined && (
          <span className="text-[10px] font-semibold text-neutral-300 dark:text-neutral-500">{count}</span>
        )}
        <span className="ml-auto flex items-center">{action}</span>
      </div>
      {children}
    </div>
  );
}
