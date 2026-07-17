import type { ReactNode } from "react";

/** A labelled section (Local / Remotes / Tags / Worktrees / Stashes). `action`
 * is an optional right-aligned header control (e.g. the Worktrees section's
 * "Remove detached" sweep). */
export function Section({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex h-6 items-center justify-between gap-2 px-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">{label}</span>
        {action}
      </div>
      {children}
    </div>
  );
}
