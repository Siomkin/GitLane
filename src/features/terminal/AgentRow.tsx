// Presentational editor row for a single terminal agent: drag handle, enable
// switch, name + command + description inputs, the live PATH-check chip, and the
// per-row actions (Check / Duplicate / Delete). Pure props in, callbacks out —
// all draft state and orchestration live in `useTerminalAgentDraft`.

import { cn } from "../../lib/cn";
import { focusRing } from "../../lib/ui";
import type { TerminalAgent } from "../../lib/api";
import { bin, type CheckStatus } from "./agentDraft";

export interface AgentRowProps {
  agent: TerminalAgent;
  check: CheckStatus | "idle";
  isDragging: boolean;
  registerEl: (el: HTMLElement | null) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onToggleEnabled: () => void;
  onNameChange: (value: string) => void;
  onCommandChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onCheck: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function AgentRow({
  agent,
  check,
  isDragging,
  registerEl,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onToggleEnabled,
  onNameChange,
  onCommandChange,
  onDescriptionChange,
  onCheck,
  onDuplicate,
  onDelete,
}: AgentRowProps) {
  const invalid = !agent.name.trim() || !agent.command.trim();
  const checking = check === "checking";
  const found = check === "found";
  const missing = check === "missing";
  const showStatus = checking || found || missing;
  const warn = invalid || missing;
  const label = agent.name.trim() || "agent";

  return (
    <div
      data-agent-card
      ref={registerEl}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn(
        "flex flex-col gap-1 rounded-xl border p-3 transition-colors",
        isDragging
          ? "border-[var(--accent)]/60 bg-white dark:bg-neutral-800 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.4)] relative z-20"
          : "border-black/[0.07] dark:border-white/[0.08] bg-white dark:bg-neutral-800/50 hover:border-black/[0.12] dark:hover:border-white/[0.14]",
        !agent.enabled && "opacity-40 grayscale",
      )}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          title="Drag to reorder"
          aria-label={`Drag ${label} to reorder`}
          className={cn(
            "shrink-0 w-6 h-8 grid place-items-center rounded-md cursor-grab active:cursor-grabbing text-neutral-300 dark:text-neutral-600 hover:text-neutral-500 dark:hover:text-neutral-400 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] touch-none",
            focusRing,
          )}
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
            <circle cx="5" cy="3.5" r="1.4" />
            <circle cx="11" cy="3.5" r="1.4" />
            <circle cx="5" cy="8" r="1.4" />
            <circle cx="11" cy="8" r="1.4" />
            <circle cx="5" cy="12.5" r="1.4" />
            <circle cx="11" cy="12.5" r="1.4" />
          </svg>
        </button>

        <button
          type="button"
          role="switch"
          aria-checked={agent.enabled}
          aria-label={agent.enabled ? `Disable ${label}` : `Enable ${label}`}
          title={agent.enabled ? "Shown in terminal panel" : "Hidden from toolbar"}
          onClick={onToggleEnabled}
          className={cn(
            "mt-2 shrink-0 w-9 h-5 rounded-full p-0.5 flex transition-colors",
            agent.enabled
              ? "bg-[var(--accent)] justify-end"
              : "bg-black/15 dark:bg-white/20 justify-start",
            focusRing,
          )}
        >
          <span className="w-4 h-4 rounded-full bg-white shadow-sm" />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <input
              value={agent.name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="Name"
              aria-label="Agent name"
              spellCheck={false}
              className={cn(
                "min-w-[13rem] flex-1 h-9 px-2.5 rounded-lg border bg-black/[0.02] dark:bg-white/[0.04] text-[13.5px] font-semibold text-neutral-900 dark:text-white outline-none focus:bg-white dark:focus:bg-neutral-800 focus:border-[var(--accent)]",
                agent.name.trim() ? "border-transparent" : "border-rose-400/70",
              )}
            />

            {showStatus && (
              <div
                title={
                  found
                    ? `${bin(agent.command)} resolves on PATH`
                    : missing
                      ? `${bin(agent.command)} was not found on PATH`
                      : "Resolving..."
                }
                className={cn(
                  "shrink-0 inline-flex items-center gap-1.5 text-[12px] font-medium px-2 h-7 rounded-md",
                  found
                    ? "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10"
                    : missing
                      ? "text-amber-600 dark:text-amber-400 bg-amber-500/10"
                      : "text-neutral-500 dark:text-neutral-400 bg-black/[0.04] dark:bg-white/[0.06]",
                )}
              >
                <span
                  className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    found ? "bg-emerald-500" : missing ? "bg-amber-500" : "bg-neutral-400 animate-pulse",
                  )}
                />
                {found ? "on PATH" : missing ? "not found" : "Checking..."}
              </div>
            )}

            <div className="ml-auto flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={onDuplicate}
                title="Duplicate"
                aria-label={`Duplicate ${label}`}
                className={cn(
                  "w-8 h-8 grid place-items-center rounded-lg text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-black/[0.05] dark:hover:bg-white/[0.08]",
                  focusRing,
                )}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                </svg>
              </button>
              <button
                type="button"
                onClick={onDelete}
                title="Delete"
                aria-label={`Delete ${label}`}
                className={cn(
                  "w-8 h-8 grid place-items-center rounded-lg text-neutral-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-500/10",
                  focusRing,
                )}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                  <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                </svg>
              </button>
            </div>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <input
              value={agent.command}
              onChange={(e) => onCommandChange(e.target.value)}
              placeholder="command --flags"
              aria-label="Agent command"
              spellCheck={false}
              className={cn(
                "flex-1 min-w-0 h-9 px-2.5 rounded-lg border bg-black/[0.02] dark:bg-white/[0.04] text-[13px] font-mono text-neutral-700 dark:text-neutral-200 outline-none focus:bg-white dark:focus:bg-neutral-800 focus:border-[var(--accent)]",
                agent.command.trim() ? "border-transparent" : "border-rose-400/70",
              )}
            />
            <button
              type="button"
              onClick={onCheck}
              disabled={checking}
              title="Check if the command exists on PATH"
              className={cn(
                "inline-flex items-center justify-center h-9 px-3.5 rounded-lg border border-black/[0.1] dark:border-white/[0.12] bg-black/[0.03] dark:bg-white/[0.06] text-[12.5px] font-medium text-neutral-700 dark:text-neutral-200 hover:bg-black/[0.06] dark:hover:bg-white/[0.1] hover:border-black/20 dark:hover:border-white/20 active:scale-[0.97] disabled:opacity-50 transition",
                focusRing,
              )}
            >
              {checking ? "Checking..." : "Check"}
            </button>
          </div>

          <div className="mt-1 flex items-center gap-3 pl-1 pr-1">
            <input
              value={agent.description}
              onChange={(e) => onDescriptionChange(e.target.value)}
              placeholder="Add a description (optional)"
              aria-label="Agent description"
              spellCheck={false}
              className="flex-1 min-w-0 h-7 bg-transparent border-0 outline-none text-[12.5px] text-neutral-500 dark:text-neutral-400 placeholder:text-neutral-300 dark:placeholder:text-neutral-600"
            />
            {warn && (
              <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-amber-600 dark:text-amber-400">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-3.5 h-3.5">
                  <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                  <path d="M12 9v4M12 17h.01" />
                </svg>
                {invalid
                  ? "Name and command are required"
                  : `"${bin(agent.command)}" isn't on PATH - button will be greyed out in the terminal`}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
