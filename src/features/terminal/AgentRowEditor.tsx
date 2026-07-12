// Expanded (editing) presentation of one terminal agent: the name field on the
// top line beside the grip + switch + Duplicate/Delete, then the command field
// with its live PATH "Check", then the description with the status chip and a
// "Done" button that collapses the row back to `AgentRowView`. A warning line
// appears while the row is invalid or its command isn't on PATH.

import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { bin } from "./agentDraft";
import type { AgentRowProps } from "./AgentRow";
import {
  DeleteGlyph,
  DragHandle,
  DuplicateGlyph,
  EnableSwitch,
  RowIconButton,
} from "./agentRowParts";

export function AgentRowEditor({
  agent,
  check,
  onHandleDown,
  onDone,
  onToggleEnabled,
  onNameChange,
  onCommandChange,
  onDescriptionChange,
  onCheck,
  onDuplicate,
  onDelete,
}: AgentRowProps) {
  const label = agent.name.trim() || "agent";
  const invalid = !agent.name.trim() || !agent.command.trim();
  const checking = check === "checking";
  const found = check === "found";
  const missing = check === "missing";
  const showStatus = checking || found || missing;
  const warn = invalid || missing;

  return (
    <div className="flex flex-col gap-2 p-2.5">
      <div className="flex items-center gap-2">
        <DragHandle label={label} onPointerDown={onHandleDown} tall />
        <EnableSwitch enabled={agent.enabled} label={label} onClick={onToggleEnabled} />
        <input
          value={agent.name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Name"
          aria-label="Agent name"
          spellCheck={false}
          className={cn(
            "h-9 min-w-0 flex-1 rounded-lg border bg-black/[0.02] px-2.5 text-[13.5px] font-semibold text-neutral-900 outline-none focus:border-[var(--accent)] focus:bg-white dark:bg-white/[0.04] dark:text-white dark:focus:bg-neutral-800",
            agent.name.trim() ? "border-transparent" : "border-rose-400/70",
          )}
        />
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <RowIconButton label={`Duplicate ${label}`} title="Duplicate" onClick={onDuplicate}>
            <DuplicateGlyph />
          </RowIconButton>
          <RowIconButton label={`Delete ${label}`} title="Delete" onClick={onDelete} danger>
            <DeleteGlyph />
          </RowIconButton>
        </div>
      </div>

      <div className="flex items-center gap-2 pl-[60px]">
        <input
          value={agent.command}
          onChange={(e) => onCommandChange(e.target.value)}
          placeholder="command --flags"
          aria-label="Agent command"
          spellCheck={false}
          className={cn(
            "h-9 min-w-0 flex-1 rounded-lg border bg-black/[0.02] px-2.5 font-mono text-[13px] text-neutral-700 outline-none focus:border-[var(--accent)] focus:bg-white dark:bg-white/[0.04] dark:text-neutral-200 dark:focus:bg-neutral-800",
            agent.command.trim() ? "border-transparent" : "border-rose-400/70",
          )}
        />
        <button
          type="button"
          onClick={onCheck}
          disabled={checking}
          title="Check if the command exists on PATH"
          className={cn(
            "inline-flex h-9 shrink-0 items-center justify-center rounded-lg border border-black/[0.1] bg-black/[0.03] px-3.5 text-[12.5px] font-medium text-neutral-700 transition hover:bg-black/[0.06] active:scale-[0.97] disabled:opacity-50 dark:border-white/[0.12] dark:bg-white/[0.06] dark:text-neutral-200 dark:hover:bg-white/[0.1]",
            focusRing,
          )}
        >
          {checking ? "Checking…" : "Check"}
        </button>
      </div>

      <div className="flex items-center gap-2 pl-[60px]">
        <input
          value={agent.description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder="Add a description (optional)"
          aria-label="Agent description"
          spellCheck={false}
          className="h-8 min-w-0 flex-1 border-0 bg-transparent px-1 text-[12.5px] text-neutral-500 outline-none placeholder:text-neutral-300 dark:text-neutral-400 dark:placeholder:text-neutral-600"
        />
        {showStatus && (
          <div
            title={
              found
                ? `${bin(agent.command)} resolves on PATH`
                : missing
                  ? `${bin(agent.command)} was not found on PATH`
                  : "Resolving…"
            }
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium",
              found
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : missing
                  ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  : "bg-black/[0.04] text-neutral-500 dark:bg-white/[0.06] dark:text-neutral-400",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                found ? "bg-emerald-500" : missing ? "bg-amber-500" : "animate-pulse bg-neutral-400",
              )}
            />
            {found ? "on PATH" : missing ? "not found" : "Checking…"}
          </div>
        )}
        <button
          type="button"
          onClick={onDone}
          className={cn(
            "h-8 shrink-0 rounded-lg px-3.5 text-[12.5px] font-semibold text-[var(--accent)] transition hover:bg-[var(--accent-soft)]",
            focusRing,
          )}
        >
          Done
        </button>
      </div>

      {warn && (
        <div className="flex items-center gap-1.5 pl-[60px] text-[12px] font-medium text-amber-600 dark:text-amber-400">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-3.5 w-3.5">
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
            <path d="M12 9v4M12 17h.01" />
          </svg>
          {invalid
            ? "Name and command are required"
            : `“${bin(agent.command)}” isn’t on PATH — button will be greyed out in the terminal`}
        </div>
      )}
    </div>
  );
}
