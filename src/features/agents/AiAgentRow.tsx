// One configured AI-agent row: reorder handle, enable switch, status, overflow
// menu, and the expanded adapter fields. Owns its ACP status subscription and
// auto-probe on expand — kept in its own file for that reason
// (architecture-rules-react.md §4).

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import type { AcpAdapter, AcpAgent } from "@/lib/api";
import { DragHandle, EnableSwitch } from "@/features/terminal/agentRowParts";
import { acpStatusOf, useAcpAgents, type AcpStatus } from "@/store/acpAgents";
import { AcpAgentFields } from "./AcpAgentFields";
import { AcpStatusPill } from "./AcpStatusPill";
import {
  adapterChoiceOf,
  bakedModelParamChips,
  CUSTOM_ADAPTER,
  effortPinOf,
} from "./acpFields";

export function AiAgentRow({
  agent,
  adapters,
  isDefault,
  editing,
  dragging,
  registerEl,
  onHandleDown,
  onChange,
  onEdit,
  onDone,
  onConnect,
  onAddAnother,
  onDelete,
}: {
  agent: AcpAgent;
  adapters: AcpAdapter[];
  isDefault: boolean;
  editing: boolean;
  dragging: boolean;
  registerEl: (el: HTMLElement | null) => void;
  onHandleDown: (e: React.PointerEvent) => void;
  onChange: (patch: Partial<AcpAgent>) => void;
  onEdit: () => void;
  onDone: () => void;
  onConnect: () => void;
  onAddAnother: () => void;
  onDelete: () => void;
}) {
  const status = useAcpAgents(acpStatusOf(agent.command));
  // What the row looked like when it opened, so Cancel can put it back. The
  // sticky save bar only knows "dirty" for the whole panel.
  const opened = useRef(agent);
  useEffect(() => {
    if (!editing) opened.current = agent;
  }, [editing, agent]);
  const choice = adapterChoiceOf(agent.command, adapters);
  const isCustom = choice === CUSTOM_ADAPTER && agent.command.trim() !== "";
  const catalogue = adapters.find((a) => a.command === agent.command.trim());
  const onPath = catalogue?.available ?? agent.available;
  const label = agent.name.trim() || "agent";
  const effortPin = effortPinOf(agent.config);

  // Expanding is when the model list becomes worth having; a probe costs one
  // adapter start. A cached ok/failed answer stands until the user rechecks.
  useEffect(() => {
    if (editing && status.state === "unknown" && agent.command.trim()) onConnect();
    // Only auto-probe when the row opens or its command changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onConnect is stable enough for this panel
  }, [editing, agent.command]);

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
          onClick={editing ? onDone : onEdit}
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
        {!editing && <AcpStatusPill status={status} onPath={onPath} compact />}
        <AgentOverflowMenu
          agent={agent}
          adapter={catalogue}
          canAddAnother={canDifferentiate(status)}
          editing={editing}
          onEdit={onEdit}
          onDone={onDone}
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
            onDone={onDone}
            onCancel={() => {
              onChange(opened.current);
              onDone();
            }}
            onDelete={onDelete}
          />
        </div>
      )}
    </div>
  );
}

/** Closing an expanded row was only ever the header/menu "Done", which nothing
 *  on screen said — so the panel names its three exits itself. */
function EditFooter({
  onDone,
  onCancel,
  onDelete,
}: {
  onDone: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="mt-3 flex items-center gap-2 border-t border-black/[0.05] pt-2.5 dark:border-white/[0.06]">
      <button
        type="button"
        onClick={onDone}
        className={cn(
          "h-8 rounded-lg bg-[var(--accent)] px-3.5 text-[13px] font-semibold text-white",
          focusRing,
        )}
      >
        Done
      </button>
      <button
        type="button"
        onClick={onCancel}
        title="Discard the edits made since this row was opened"
        className={cn(
          "h-8 rounded-lg px-3 text-[13px] text-neutral-500 hover:bg-black/[0.05] dark:text-neutral-400 dark:hover:bg-white/[0.07]",
          focusRing,
        )}
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onDelete}
        className={cn(
          "ml-auto h-8 rounded-lg px-3 text-[13px] font-semibold text-rose-600 hover:bg-rose-500/10 dark:text-rose-400",
          focusRing,
        )}
      >
        Remove agent
      </button>
    </div>
  );
}

function canDifferentiate(status: AcpStatus): boolean {
  // Until probed we can't know, so assume a second one might be worth adding —
  // better than blocking an action that would have been valid.
  if (status.state !== "ok" || !status.probe) return true;
  return (
    status.probe.models.length > 0 ||
    status.probe.configOptions.some((option) => option.category === "thought_level")
  );
}

function AgentOverflowMenu({
  agent,
  adapter,
  canAddAnother,
  editing,
  onEdit,
  onDone,
  onAddAnother,
  onDelete,
}: {
  agent: AcpAgent;
  adapter: AcpAdapter | undefined;
  canAddAnother: boolean;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  onAddAnother: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const itemCls =
    "w-full rounded-lg px-3 h-9 text-left text-[13px] text-neutral-700 hover:bg-black/[0.05] dark:text-neutral-200 dark:hover:bg-white/[0.07]";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={`Actions for ${agent.name.trim() || "agent"}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "grid h-8 w-8 place-items-center rounded-lg text-neutral-400 transition hover:bg-black/[0.05] hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-white/10 dark:hover:text-neutral-200",
          focusRing,
        )}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden>
          <circle cx="5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="19" cy="12" r="1.7" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-20 w-[232px] rounded-xl border border-black/10 bg-white p-1 shadow-[0_18px_44px_-8px_rgba(0,0,0,0.25)] dark:border-white/10 dark:bg-neutral-800 dark:shadow-[0_18px_44px_-8px_rgba(0,0,0,0.6)]"
        >
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => {
              setOpen(false);
              if (editing) onDone();
              else onEdit();
            }}
          >
            {editing ? "Done" : "Configure…"}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canAddAnother || !agent.command.trim()}
            title={
              canAddAnother
                ? "Add another agent for the same adapter — how two models stay a click apart"
                : "This adapter offers no model or effort choice, so a second agent would be identical"
            }
            className={cn(itemCls, "disabled:cursor-default disabled:opacity-45")}
            onClick={() => {
              setOpen(false);
              onAddAnother();
            }}
          >
            Add another profile
          </button>
          {adapter?.install ? (
            <button
              type="button"
              role="menuitem"
              className={itemCls}
              onClick={() => {
                void navigator.clipboard?.writeText(adapter.install).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy install command"}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="h-9 w-full rounded-lg px-3 text-left text-[13px] text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
