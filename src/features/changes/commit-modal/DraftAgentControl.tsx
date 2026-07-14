// The composer's compact "Draft / Improve" affordance (commit panel redesign):
// one control that both picks the terminal agent and starts the draft. The
// last-used agent is highlighted with a check so the button reads as "draft
// with <agent>" at a glance.

import type { TerminalAgent } from "@/lib/api";
import { CheckIcon, ChevronDownIcon, SparkleIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { useUpwardPopover } from "./useUpwardPopover";

export function DraftAgentControl({
  agents,
  activeAgentId,
  improve,
  disabled,
  disabledTitle,
  onPick,
}: {
  /** The enabled terminal agents (may include ones not on PATH). */
  agents: TerminalAgent[];
  /** Id of the agent last used to draft, shown as the active choice. */
  activeAgentId: string | null;
  /** True once a message exists — the affordance flips from Draft to Improve. */
  improve: boolean;
  disabled: boolean;
  disabledTitle: string;
  onPick: (agent: TerminalAgent) => void;
}) {
  const { ref, open, menuStyle, toggle, close } = useUpwardPopover();

  const label = improve ? "Improve" : "Draft";
  const available = agents.filter((a) => a.available);
  const blocked = disabled || available.length === 0;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={toggle}
        disabled={blocked}
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          disabled
            ? disabledTitle
            : available.length === 0
              ? "No available agents on PATH"
              : `${label} the commit message with an agent`
        }
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-[color:var(--accent)] transition-colors disabled:cursor-not-allowed disabled:opacity-45",
          open ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--accent-soft)]",
          focusRing,
        )}
      >
        <SparkleIcon className="h-3.5 w-3.5" />
        {label}
        <ChevronDownIcon className="h-3 w-3" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={`${label} with agent`}
          style={menuStyle}
          className="fixed z-[80] max-h-[280px] w-[220px] overflow-auto rounded-xl border border-black/10 bg-white py-1 shadow-[0_18px_44px_-8px_rgba(0,0,0,0.42)] dark:border-white/10 dark:bg-neutral-800"
        >
          <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
            {label} with
          </div>
          {agents.map((agent) => {
            const active = agent.id === activeAgentId;
            return (
              <button
                key={agent.id}
                type="button"
                role="menuitem"
                disabled={!agent.available}
                onClick={() => {
                  close();
                  onPick(agent);
                }}
                title={agent.available ? agent.command : `${agent.command} was not found on PATH`}
                className={cn(
                  "flex h-8 w-full items-center gap-2 px-3 text-left text-[13px] hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-45 dark:hover:bg-white/5",
                  active
                    ? "font-medium text-[color:var(--accent)]"
                    : "text-neutral-700 dark:text-neutral-200",
                  focusRing,
                )}
              >
                <SparkleIcon className="h-3.5 w-3.5 shrink-0 text-[color:var(--accent)]" />
                <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                {!agent.available ? (
                  <span className="shrink-0 text-[11px] text-neutral-400">not on PATH</span>
                ) : active ? (
                  <CheckIcon className="h-3.5 w-3.5 shrink-0 text-[color:var(--accent)]" />
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
