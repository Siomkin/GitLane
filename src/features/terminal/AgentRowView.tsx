// Compact (collapsed) presentation of one terminal agent: a single 46px line
// with the reorder grip, enable switch, name + command, a live PATH status dot,
// and the hover-revealed Edit / Duplicate / Delete actions. Clicking the name
// (or the pencil) expands the row into `AgentRowEditor`.

import { cn } from "../../lib/cn";
import { bin } from "./agentDraft";
import type { AgentRowProps } from "./AgentRow";
import {
  DeleteGlyph,
  DragHandle,
  DuplicateGlyph,
  EditGlyph,
  EnableSwitch,
  RowIconButton,
} from "./agentRowParts";

export function AgentRowView({
  agent,
  check,
  onHandleDown,
  onEdit,
  onToggleEnabled,
  onDuplicate,
  onDelete,
}: AgentRowProps) {
  const label = agent.name.trim() || "agent";
  const found = check === "found";
  const missing = check === "missing";
  const checking = check === "checking";
  const showStatus = found || missing || checking;

  return (
    <div className="group/row flex h-[46px] items-center gap-2 pl-1 pr-2">
      <DragHandle label={label} onPointerDown={onHandleDown} revealOnHover />
      <EnableSwitch enabled={agent.enabled} label={label} onClick={onToggleEnabled} />

      <button
        type="button"
        onClick={onEdit}
        className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
      >
        <span
          className={cn(
            "max-w-[280px] shrink-0 truncate text-[14px] font-semibold",
            agent.name.trim()
              ? "text-neutral-900 dark:text-white"
              : "italic text-neutral-400 dark:text-neutral-500",
          )}
        >
          {agent.name.trim() || "Untitled agent"}
        </span>
        <span className="min-w-0 truncate font-mono text-[12.5px] text-neutral-400 dark:text-neutral-500">
          {agent.command}
        </span>
      </button>

      {showStatus && (
        <span
          title={
            found
              ? `${bin(agent.command)} resolves on PATH`
              : missing
                ? `${bin(agent.command)} was not found on PATH`
                : "Resolving…"
          }
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            found ? "bg-emerald-500" : missing ? "bg-amber-500" : "animate-pulse bg-neutral-400",
          )}
        />
      )}

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100">
        <RowIconButton label={`Edit ${label}`} title="Edit" onClick={onEdit}>
          <EditGlyph />
        </RowIconButton>
        <RowIconButton label={`Duplicate ${label}`} title="Duplicate" onClick={onDuplicate}>
          <DuplicateGlyph />
        </RowIconButton>
        <RowIconButton label={`Delete ${label}`} title="Delete" onClick={onDelete} danger>
          <DeleteGlyph />
        </RowIconButton>
      </div>
    </div>
  );
}
