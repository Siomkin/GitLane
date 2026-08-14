// One configured AI-agent row: reorder handle, enable switch, status, overflow
// menu, and the expanded adapter fields. Owns its ACP status subscription and
// auto-probe on expand — kept in its own file for that reason
// (architecture-rules-react.md §4).

import { useEffect } from "react";
import { cn } from "@/lib/cn";
import type { AcpAdapter, AcpAgent } from "@/lib/api";
import { DragHandle, EnableSwitch } from "@/features/terminal/agentRowParts";
import { acpStatusOf, useAcpAgents } from "@/store/acpAgents";
import { AcpAgentFields } from "./AcpAgentFields";
import { AcpStatusPill } from "./AcpStatusPill";
import {
  adapterChoiceOf,
  bakedModelParamChips,
  CUSTOM_ADAPTER,
  effortPinOf,
  readinessOf,
} from "./acpFields";
import { AgentOverflowMenu } from "./ai-agent-row/AgentOverflowMenu";
import { canDifferentiate } from "./ai-agent-row/differentiation";
import { EditFooter } from "./ai-agent-row/EditFooter";

export function AiAgentRow({
  agent,
  adapters,
  isDefault,
  editing,
  dirty,
  saveDisabled,
  saving,
  dragging,
  registerEl,
  onHandleDown,
  onChange,
  onEdit,
  onCollapse,
  onSave,
  onCancel,
  onConnect,
  onAddAnother,
  onDelete,
}: {
  agent: AcpAgent;
  adapters: AcpAdapter[];
  isDefault: boolean;
  editing: boolean;
  dirty: boolean;
  saveDisabled: boolean;
  saving: boolean;
  dragging: boolean;
  registerEl: (el: HTMLElement | null) => void;
  onHandleDown: (e: React.PointerEvent) => void;
  onChange: (patch: Partial<AcpAgent>) => void;
  onEdit: () => void;
  onCollapse: () => void;
  onSave: () => void;
  onCancel: () => void;
  onConnect: () => void;
  onAddAnother: () => void;
  onDelete: () => void;
}) {
  const status = useAcpAgents(acpStatusOf(agent.command));
  const choice = adapterChoiceOf(agent.command, adapters);
  const isCustom = choice === CUSTOM_ADAPTER && agent.command.trim() !== "";
  const catalogue = adapters.find((a) => a.command === agent.command.trim());
  const readiness = readinessOf(agent.command, catalogue?.available ?? agent.available);
  const label = agent.name.trim() || "agent";
  const effortPin = effortPinOf(agent.config);

  // Expanding is when the model list becomes worth having; a probe costs one
  // adapter start. A cached ok/failed answer stands until the user rechecks.
  //
  // Only for a catalogue command: a custom one changes on every keystroke, and
  // auto-probing each intermediate string would spawn a process per character.
  // Those launch from Connect, once the user has finished typing.
  const knownCommand = catalogue !== undefined;
  useEffect(() => {
    if (editing && knownCommand && status.state === "unknown" && agent.command.trim()) onConnect();
    // Only auto-probe when the row opens or its command changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onConnect is stable enough for this panel
  }, [editing, knownCommand, agent.command]);

  return (
    <div
      ref={registerEl}
      style={
        dragging
          ? {
              opacity: 0.95,
              boxShadow: "0 18px 40px -12px rgba(0,0,0,0.4)",
              position: "relative",
              zIndex: 20,
            }
          : undefined
      }
      className={cn(
        "rounded-xl border transition-colors",
        dragging
          ? "border-[var(--accent)]/60 bg-white dark:bg-neutral-800"
          : agent.enabled
            ? "border-black/[0.09] bg-white/70 dark:border-white/[0.09] dark:bg-neutral-800/70"
            : "border-black/[0.05] bg-black/[0.015] dark:border-white/[0.05] dark:bg-neutral-800/30",
      )}
    >
      <div className="group/row flex h-[58px] items-center gap-3 pl-2.5 pr-2.5">
        <DragHandle label={label} onPointerDown={onHandleDown} />
        <EnableSwitch
          enabled={agent.enabled}
          label={label}
          title={agent.enabled ? "Enabled in GitLane" : "Disabled in GitLane"}
          onClick={() => onChange({ enabled: !agent.enabled })}
        />
        <button
          type="button"
          onClick={editing ? onCollapse : onEdit}
          className="min-w-0 flex-1 rounded-lg px-1 py-1 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "truncate text-[14.5px] font-semibold",
                agent.enabled
                  ? "text-neutral-900 dark:text-white"
                  : "text-neutral-400 dark:text-neutral-500",
                !agent.name.trim() && "italic",
              )}
            >
              {agent.name.trim() || "Untitled agent"}
            </span>
            {isDefault && (
              <span className="grid h-[18px] shrink-0 place-items-center rounded bg-[var(--accent-soft)] px-1.5 text-[10.5px] font-semibold tracking-wide text-[color:var(--accent)]">
                DEFAULT
              </span>
            )}
            {isCustom && (
              <span className="grid h-[18px] shrink-0 place-items-center rounded bg-black/[0.06] px-1.5 text-[10.5px] font-semibold tracking-wide text-neutral-500 dark:bg-white/10 dark:text-neutral-400">
                CUSTOM ADAPTER
              </span>
            )}
            {!editing && agent.model && (
              <span className="shrink-0 rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 font-mono text-[10.5px] text-[color:var(--accent)]">
                {agent.model.includes("[")
                  ? agent.model.slice(0, agent.model.indexOf("["))
                  : agent.model}
              </span>
            )}
            {!editing &&
              (effortPin
                ? [
                    <span
                      key="effort"
                      className="shrink-0 rounded-md bg-black/[0.04] px-1.5 py-0.5 text-[10.5px] text-neutral-500 dark:bg-white/[0.06] dark:text-neutral-400"
                    >
                      {effortPin}
                    </span>,
                  ]
                : bakedModelParamChips(agent.model).map((chip) => (
                    <span
                      key={chip.key}
                      className="shrink-0 rounded-md bg-black/[0.04] px-1.5 py-0.5 text-[10.5px] text-neutral-500 dark:bg-white/[0.06] dark:text-neutral-400"
                    >
                      {chip.label}: {chip.value}
                    </span>
                  )))}
          </div>
          <div className="mt-0.5 truncate font-mono text-[12px] text-neutral-400 dark:text-neutral-500">
            {agent.command.trim() || "No command yet"}
          </div>
        </button>
        {!editing && <AcpStatusPill status={status} readiness={readiness} compact />}
        <AgentOverflowMenu
          agent={agent}
          adapter={catalogue}
          canAddAnother={canDifferentiate(status)}
          editing={editing}
          dirty={dirty}
          onEdit={onEdit}
          onCollapse={onCollapse}
          onSave={onSave}
          onAddAnother={onAddAnother}
          onDelete={onDelete}
        />
      </div>

      {editing && (
        <div className="border-t border-black/[0.05] px-2.5 pb-2.5 pt-2.5 dark:border-white/[0.06]">
          <div className="mb-2.5">
            <label className="mb-1 block text-[11px] font-semibold tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
              NAME
            </label>
            <input
              value={agent.name}
              onChange={(e) => onChange({ name: e.target.value })}
              placeholder="Name"
              aria-label="Agent name"
              spellCheck={false}
              className={cn(
                "h-9 w-full rounded-lg border bg-black/[0.02] px-2.5 text-[13.5px] font-semibold text-neutral-900 outline-none focus:border-[var(--accent)] focus:bg-white dark:bg-white/[0.04] dark:text-white dark:focus:bg-neutral-800",
                agent.name.trim() ? "border-transparent" : "border-rose-400/70",
              )}
            />
          </div>
          <AcpAgentFields
            command={agent.command}
            model={agent.model}
            config={agent.config}
            adapters={adapters}
            status={status}
            readiness={readiness}
            // A model id / config pin belongs to the adapter that offered it, so
            // switching adapters clears them rather than asking the new one for
            // values it has never heard of.
            onCommandChange={(value) => onChange({ command: value, model: "", config: {} })}
            onModelChange={(value) => onChange({ model: value })}
            onConfigChange={(id, value) => {
              const next = { ...agent.config };
              if (value) next[id] = value;
              else delete next[id];
              onChange({ config: next });
            }}
            onConnect={onConnect}
          />
          <EditFooter
            label={label}
            saveDisabled={saveDisabled}
            saving={saving}
            onSave={onSave}
            onCancel={onCancel}
            onDelete={onDelete}
          />
        </div>
      )}
    </div>
  );
}
