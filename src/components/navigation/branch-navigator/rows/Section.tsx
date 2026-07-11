import type { ReactNode } from "react";

/** A labelled section (Local / Remotes / Tags / Worktrees / Stashes). */
export function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="flex h-6 items-center px-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">{label}</span>
      </div>
      {children}
    </div>
  );
}
