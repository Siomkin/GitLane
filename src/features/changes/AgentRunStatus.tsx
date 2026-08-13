import type { ReactNode } from "react";
import { AgentSpinner } from "./AgentSpinner";

/** In-flight agent status: accent wash, spinner, live label, optional elapsed.
 *  Shared by Draft / Describe, conflict resolve, and AI actions so every wait
 *  reads as the same kind of work. */
export function AgentRunStatus({
  children,
  elapsed,
}: {
  children: ReactNode;
  elapsed?: string | null;
}) {
  return (
    <p
      role="status"
      className="mt-2 flex items-center gap-2 rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-xs text-[color:var(--accent)]"
    >
      <AgentSpinner />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {elapsed && <span className="shrink-0 tabular-nums opacity-70">{elapsed}</span>}
    </p>
  );
}
