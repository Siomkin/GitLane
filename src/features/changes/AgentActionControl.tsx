import type { TerminalAgent } from "@/lib/api";
import { CheckIcon, ChevronDownIcon, SparkleIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { useFixedPopover } from "./useFixedPopover";

export function AgentActionControl({
  agents,
  activeAgentId,
  label,
  actionTitle,
  buttonAriaLabel,
  menuLabel,
  menuAriaLabel = menuLabel,
  placement = "up",
  disabled,
  disabledTitle,
  onPick,
}: {
  agents: TerminalAgent[];
  activeAgentId: string | null;
  label: string;
  /** Hover title when the control is usable; defaults to `${label} with an agent`. */
  actionTitle?: string;
  buttonAriaLabel?: string;
  menuLabel: string;
  menuAriaLabel?: string;
  placement?: "up" | "down";
  disabled: boolean;
  disabledTitle: string;
  onPick: (agent: TerminalAgent) => void;
}) {
  const { ref, menuRef, open, menuStyle, toggle, close, portal } = useFixedPopover({ placement });
  const available = agents.filter((agent) => agent.available);
  const blocked = disabled || available.length === 0;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={toggle}
        disabled={blocked}
        aria-label={buttonAriaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          disabled
            ? disabledTitle
            : available.length === 0
              ? "No available agents on PATH"
              : (actionTitle ?? `${label} with an agent`)
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

      {portal(() => (
        <div
          ref={menuRef}
          role="menu"
          aria-label={menuAriaLabel}
          style={menuStyle}
          className="fixed z-[80] max-h-[280px] w-[220px] overflow-auto rounded-xl border border-black/10 bg-white py-1 shadow-[0_18px_44px_-8px_rgba(0,0,0,0.42)] dark:border-white/10 dark:bg-neutral-800"
        >
          <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
            {menuLabel}
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
      ))}
    </div>
  );
}
