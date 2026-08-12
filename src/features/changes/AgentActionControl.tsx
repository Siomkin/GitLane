// The agent picker shared by every in-app action (Draft / Improve, Describe).
//
// Every agent offered here answers over ACP. It deliberately does not gate on
// `available` (a PATH lookup of the adapter's executable): an adapter run
// through `npx` resolves at launch time, not lookup time, so that flag would
// hide perfectly good agents.
//
// Each row shows the model the agent is pinned to, because the agent's own name
// ("codex 5.6 sol light") is just a label the user typed — the model is what
// actually runs. Expanding a row switches it: the model list comes from the
// adapter itself, and picking one saves through immediately. Settings can still
// edit it, but nobody should have to go there to change models.

import { useState } from "react";
import type { AcpAgent } from "@/lib/api";
import { CheckIcon, ChevronDownIcon, SparkleIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { modelLabel } from "@/features/agents/acpFields";
import { useAgentModelPicker } from "@/features/agents/useAgentModelPicker";
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
  agents: AcpAgent[];
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
  onPick: (agent: AcpAgent) => void;
}) {
  const { ref, menuRef, open, menuStyle, toggle, close, portal } = useFixedPopover({ placement });
  const picker = useAgentModelPicker();
  // At most one agent's model list is open, so the menu never becomes a wall.
  const [modelsOpenFor, setModelsOpenFor] = useState<string | null>(null);
  const blocked = disabled || agents.length === 0;

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
            : agents.length === 0
              ? "No agent is set up to answer in the app — add an ACP adapter in Settings"
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
          className="fixed z-[80] max-h-[340px] w-[260px] overflow-auto rounded-xl border border-black/10 bg-white py-1 shadow-[0_18px_44px_-8px_rgba(0,0,0,0.42)] dark:border-white/10 dark:bg-neutral-800"
        >
          <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
            {menuLabel}
          </div>
          {agents.map((agent) => (
            <AgentMenuItem
              key={agent.id}
              agent={agent}
              active={agent.id === activeAgentId}
              picker={picker}
              expanded={modelsOpenFor === agent.id}
              onToggleModels={() =>
                setModelsOpenFor((current) => (current === agent.id ? null : agent.id))
              }
              onRun={() => {
                close();
                onPick(agent);
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** One agent in the picker: click the name to run it, click the model chip to
 *  switch models. The chip only appears once the adapter has told us what it
 *  offers — `claude-agent-acp`, for one, exposes no model selection at all. */
function AgentMenuItem({
  agent,
  active,
  picker,
  expanded,
  onToggleModels,
  onRun,
}: {
  agent: AcpAgent;
  active: boolean;
  picker: ReturnType<typeof useAgentModelPicker>;
  expanded: boolean;
  onToggleModels: () => void;
  onRun: () => void;
}) {
  const models = picker.modelsFor(agent);
  const loading = picker.isLoading(agent);
  const current = agent.model;

  return (
    <>
      <div
        className={cn(
          "flex w-full items-center gap-1 pl-3 pr-1.5 hover:bg-black/5 dark:hover:bg-white/5",
          active && "text-[color:var(--accent)]",
        )}
      >
        <button
          type="button"
          role="menuitem"
          onClick={onRun}
          title={agent.command}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-[13px]",
            active ? "font-medium" : "text-neutral-700 dark:text-neutral-200",
            focusRing,
          )}
        >
          <SparkleIcon className="h-3.5 w-3.5 shrink-0 text-[color:var(--accent)]" />
          <span className="min-w-0 flex-1 truncate">{agent.name}</span>
          {active && <CheckIcon className="h-3.5 w-3.5 shrink-0" />}
        </button>
        {/* Probing launches the adapter, so it waits for intent — hovering the
            model control is intent enough, and the result is cached. */}
        <button
          type="button"
          aria-label={`Choose a model for ${agent.name}`}
          aria-expanded={expanded}
          onMouseEnter={() => picker.ensureProbed(agent)}
          onFocus={() => picker.ensureProbed(agent)}
          onClick={() => {
            picker.ensureProbed(agent);
            onToggleModels();
          }}
          title={current ? `Model: ${current}` : "Model: adapter default"}
          className={cn(
            "flex max-w-[110px] shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[10.5px] text-neutral-400 hover:bg-black/[0.06] hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-white/10 dark:hover:text-neutral-300",
            focusRing,
          )}
        >
          <span className="truncate">{current || "default"}</span>
          <ChevronDownIcon className={cn("h-2.5 w-2.5 shrink-0", expanded && "rotate-180")} />
        </button>
      </div>

      {expanded && (
        <div className="mb-1 ml-6 mr-2 border-l border-black/10 pl-2 dark:border-white/10">
          {loading && (
            <div className="py-1 text-[11px] text-neutral-400">Asking the adapter…</div>
          )}
          {!loading && models.length === 0 && (
            <div className="py-1 text-[11px] leading-relaxed text-neutral-400">
              This adapter offers no model choice.
            </div>
          )}
          {models.length > 0 &&
            [{ id: "", name: "Adapter default", description: "" }, ...models].map((model) => (
              <button
                key={model.id || "__default"}
                type="button"
                onClick={() => {
                  void picker.pick(agent, model.id);
                  onToggleModels();
                }}
                title={model.description || undefined}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11.5px] hover:bg-black/5 dark:hover:bg-white/5",
                  model.id === current
                    ? "font-medium text-[color:var(--accent)]"
                    : "text-neutral-600 dark:text-neutral-300",
                  focusRing,
                )}
              >
                <span className="min-w-0 flex-1 truncate">{modelLabel(model)}</span>
                {model.id === current && <CheckIcon className="h-3 w-3 shrink-0" />}
              </button>
            ))}
        </div>
      )}
    </>
  );
}
