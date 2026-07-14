// "Commit with agent" split control (GL-213 follow-up): the model is no longer a
// separate footer selector — clicking the button opens a small popup of the
// enabled terminal agents, and clicking one commits with that agent.

import { useRef, useState } from "react";

import type { TerminalAgent } from "@/lib/api";
import { useDismiss } from "@/hooks/useDismiss";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";

const SparkleIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 text-[color:var(--accent)]" aria-hidden>
    <path d="M12 3l1.6 4.9L18.5 9.5l-4.9 1.6L12 16l-1.6-4.9L5.5 9.5l4.9-1.6z" />
  </svg>
);

export function CommitWithAgentButton({
  agents,
  disabled,
  onPick,
  label = "Commit with agent",
  disabledTitle = "Set a usable Git identity before committing with an agent",
}: {
  /** The enabled terminal agents (may include ones not on PATH). */
  agents: TerminalAgent[];
  /** Blocks committing (e.g. no usable commit identity). */
  disabled: boolean;
  onPick: (agent: TerminalAgent) => void;
  /** Visible button text and accessible menu label. */
  label?: string;
  disabledTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  if (agents.length === 0) {
    return (
      <span className="text-[12px] text-amber-600 dark:text-amber-400">No enabled agents. Add one in Settings.</span>
    );
  }

  const available = agents.filter((a) => a.available);
  const blocked = disabled || available.length === 0;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={blocked}
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          disabled
            ? disabledTitle
            : available.length === 0
              ? "No available agents on PATH"
              : `Choose an agent for ${label.toLowerCase()}`
        }
        className={cn(
          "flex h-9 items-center gap-1.5 rounded-lg border border-black/10 px-3.5 text-[13px] font-medium text-neutral-700 hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-45 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5",
          focusRing,
        )}
      >
        <SparkleIcon />
        {label}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 text-neutral-400" aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          aria-label={label}
          className="absolute bottom-full left-0 z-[80] mb-2 max-h-[280px] w-[260px] overflow-auto rounded-xl border border-black/10 bg-white p-1.5 shadow-[0_18px_44px_-8px_rgba(0,0,0,0.42)] dark:border-white/10 dark:bg-neutral-800"
        >
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              role="menuitem"
              disabled={!agent.available}
              onClick={() => {
                setOpen(false);
                onPick(agent);
              }}
              title={agent.available ? agent.command : `${agent.command} was not found on PATH`}
              className={cn(
                "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left disabled:cursor-not-allowed disabled:opacity-45",
                "hover:bg-black/[0.04] dark:hover:bg-white/[0.05]",
                focusRing,
              )}
            >
              <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-neutral-800 dark:text-neutral-100">
                <SparkleIcon />
                <span className="truncate">{agent.name}</span>
              </span>
              {!agent.available && <span className="shrink-0 text-[11px] text-neutral-400">not on PATH</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
