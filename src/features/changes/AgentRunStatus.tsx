import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { AgentSpinner } from "./AgentSpinner";

/** In-flight agent status: accent wash, spinner, live label, optional elapsed
 *  and a trailing action (the composer's "Stop waiting"). Shared by the commit
 *  composer's Draft, conflict resolve, and AI actions so every wait reads as
 *  the same kind of work. `className` replaces the default top margin. */
export function AgentRunStatus({
  children,
  elapsed,
  action,
  className = "mt-2",
}: {
  children: ReactNode;
  elapsed?: string | null;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <p
      role="status"
      className={cn(
        "flex items-center gap-2 rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-xs text-[color:var(--accent)]",
        className,
      )}
    >
      <AgentSpinner />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {elapsed && <span className="shrink-0 tabular-nums opacity-70">{elapsed}</span>}
      {action}
    </p>
  );
}
