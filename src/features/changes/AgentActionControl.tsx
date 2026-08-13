// The agent picker shared by every in-app action (Draft / Improve, Describe,
// AI actions). Clicking an agent either runs the action or selects it, depending
// on the caller; expanding a row switches the model / effort the adapter offers.
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
import type { AcpAgent, AcpConfigOption, AcpModel } from "@/lib/api";
import { CheckIcon, ChevronDownIcon, SparkleIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { effortPinOf, modelLabel } from "@/features/agents/acpFields";
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
  variant = "action",
  disabled,
  disabledTitle,
  onOpen,
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
  /** `action` is the Draft / Describe trigger; `select` is a persistent agent
   *  picker (AI actions header) that uses the same menu. */
  variant?: "action" | "select";
  disabled: boolean;
  disabledTitle: string;
  /** Fired when the menu is about to open, so a sibling menu can close. */
  onOpen?: () => void;
  onPick: (agent: AcpAgent) => void;
}) {
  const { ref, menuRef, open, menuStyle, toggle, close, portal } = useFixedPopover({ placement });
  const picker = useAgentModelPicker();
  // At most one agent's model list is open, so the menu never becomes a wall.
  const [modelsOpenFor, setModelsOpenFor] = useState<string | null>(null);
  const blocked = disabled || (variant === "action" && agents.length === 0);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={(event) => {
          if (!open) onOpen?.();
          toggle(event);
        }}
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
          variant === "select"
            ? cn(
                "flex h-8 items-center gap-2 whitespace-nowrap rounded-lg border border-black/10 bg-black/[0.03] pl-2.5 pr-2 text-[12.5px] font-medium text-neutral-700 hover:bg-black/[0.06] disabled:cursor-not-allowed disabled:opacity-45 dark:border-white/[0.12] dark:bg-white/[0.05] dark:text-neutral-200 dark:hover:bg-white/[0.09]",
                open && "bg-black/[0.06] dark:bg-white/[0.09]",
              )
            : cn(
                "flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-[color:var(--accent)] transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                open ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--accent-soft)]",
              ),
          focusRing,
        )}
      >
        <SparkleIcon
          className={cn(
            variant === "select" ? "h-3.5 w-3.5 text-[color:var(--accent)]" : "h-3.5 w-3.5",
          )}
        />
        {label}
        <ChevronDownIcon className={variant === "select" ? "h-3.5 w-3.5 text-neutral-400" : "h-3 w-3"} />
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
          {agents.length === 0 ? (
            <div className="px-3 py-2 text-[13px] text-neutral-500">Add an ACP adapter in Settings</div>
          ) : (
            agents.map((agent) => (
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
            ))
          )}
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
  const configOptions = picker.configOptionsFor(agent);
  const loading = picker.isLoading(agent);
  const current = agent.model;
  const effort = effortPinOf(agent.config);
  const chipLabel = [current || "default", effort].filter(Boolean).join(" · ");

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
        {/* Probing launches the adapter — for an `npx` command that means
            downloading and running a package. Hover and focus are not consent
            for that, so only the click opens one. */}
        <button
          type="button"
          aria-label={`Choose a model for ${agent.name}`}
          aria-expanded={expanded}
          onClick={() => {
            picker.ensureProbed(agent);
            onToggleModels();
          }}
          title={current ? `Model: ${current}` : "Model: adapter default"}
          className={cn(
            "flex max-w-[140px] shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[10.5px] text-neutral-400 hover:bg-black/[0.06] hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-white/10 dark:hover:text-neutral-300",
            focusRing,
          )}
        >
          <span className="truncate">{chipLabel}</span>
          <ChevronDownIcon className={cn("h-2.5 w-2.5 shrink-0", expanded && "rotate-180")} />
        </button>
      </div>

      {expanded && (
        <div className="mb-1 ml-6 mr-2 border-l border-black/10 pl-2 dark:border-white/10">
          {loading && (
            <div className="py-1 text-[11px] text-neutral-400">Asking the adapter…</div>
          )}
          {!loading && models.length === 0 && configOptions.length === 0 && (
            <div className="py-1 text-[11px] leading-relaxed text-neutral-400">
              This adapter offers no model choice.
            </div>
          )}
          {models.length > 0 &&
            [{ id: "", name: "Adapter default", description: "" }, ...models].map((model) => (
              <PickerOption
                key={model.id || "__default"}
                label={modelLabel(model)}
                title={model.description || undefined}
                active={model.id === current}
                onPick={() => {
                  void picker.pick(agent, model.id);
                  onToggleModels();
                }}
              />
            ))}
          {configOptions.map((option) => (
            <ConfigOptionList
              key={option.id}
              agent={agent}
              option={option}
              picker={picker}
              onPicked={onToggleModels}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ConfigOptionList({
  agent,
  option,
  picker,
  onPicked,
}: {
  agent: AcpAgent;
  option: AcpConfigOption;
  picker: ReturnType<typeof useAgentModelPicker>;
  onPicked: () => void;
}) {
  const current = agent.config[option.id] ?? "";
  return (
    <>
      <div className="px-1.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
        {option.name || option.id}
      </div>
      {[{ id: "", name: "Adapter default", description: "" } as AcpModel, ...option.options].map(
        (entry) => (
          <PickerOption
            key={entry.id || `__default-${option.id}`}
            label={modelLabel(entry)}
            title={entry.description || undefined}
            active={entry.id === current}
            onPick={() => {
              void picker.pickConfig(agent, option.id, entry.id);
              onPicked();
            }}
          />
        ),
      )}
    </>
  );
}

function PickerOption({
  label,
  title,
  active,
  onPick,
}: {
  label: string;
  title?: string;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      title={title}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11.5px] hover:bg-black/5 dark:hover:bg-white/5",
        active ? "font-medium text-[color:var(--accent)]" : "text-neutral-600 dark:text-neutral-300",
        focusRing,
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {active && <CheckIcon className="h-3 w-3 shrink-0" />}
    </button>
  );
}
