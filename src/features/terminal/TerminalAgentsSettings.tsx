// The "Terminal Agents" settings panel: a CRUD + reorder editor for the user's
// terminal agents (the AI CLIs launched from the terminal panel). Rows are
// compact by default and expand into an inline editor on click; draft state,
// validation, and save/reset orchestration live in `useTerminalAgentDraft`, and
// each row is the presentational `AgentRow`. This container owns only the
// list-level view concerns: the pointer drag-to-reorder gesture and the FLIP
// reorder animation.

import { cn } from "@/lib/cn";
import { useListReorder } from "@/components/ui/useListReorder";
import { focusRing } from "@/lib/ui";
import { type TerminalAgent } from "@/lib/api";
import { AgentRow } from "./AgentRow";
import { useTerminalAgentDraft } from "./useTerminalAgentDraft";
import { previewAvailability, type PreviewAvailability } from "./agentDraft";

// Re-export so existing importers (and tests) keep a single import site even
// though the implementation now lives in the pure-helper module.
export { previewAvailability } from "./agentDraft";

export function TerminalAgentsSettings() {
  const editor = useTerminalAgentDraft();
  const { draft, saved, loading, error, saving, dirty, valid, checks } = editor;

  // Drag-to-reorder + FLIP live in a shared hook; AI Agents uses the same one.
  const layoutKey = draft.map((a) => `${a.id}${editor.isEditing(a.id) ? "*" : ""}`).join(" ");
  const { draggingId, registerEl, startDrag } = useListReorder(
    draft.map((a) => a.id),
    editor.move,
    layoutKey,
  );

  const previewAgents = draft.filter((a) => a.enabled && a.name.trim() && a.command.trim());
  const savedAgents = new Map(saved.map((agent) => [agent.id, agent]));
  const saveDisabled = !dirty || !valid || saving;

  return (
    <div className="flex h-full w-full flex-col">
      <div className="-mx-1 flex flex-none items-start justify-between gap-4 bg-white px-1 pb-5 pt-1 dark:bg-neutral-800">
        <div className="min-w-0">
          <h2 className="text-[30px] font-bold tracking-tight text-neutral-900 dark:text-white">
            Terminal Agents
          </h2>
          <p className="mt-2 max-w-[560px] text-[15px] text-neutral-500 text-pretty dark:text-neutral-400">
            AI CLIs launched from the terminal panel. Toggle to show or hide; hover a row to
            reorder, edit, or remove.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-1.5">
          <button type="button"
            onClick={editor.reset}
            disabled={saving}
            className={cn(
              "h-9 rounded-lg px-3.5 text-[13px] font-semibold text-neutral-500 transition hover:bg-black/[0.04] hover:text-neutral-800 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-white/[0.06] dark:hover:text-neutral-200",
              focusRing,
            )}
          >
            Reset to defaults
          </button>
          <button type="button"
            disabled={saveDisabled}
            onClick={() => void editor.save()}
            className={cn(
              "h-9 rounded-lg bg-[var(--accent)] px-4 text-[13px] font-semibold text-white shadow-sm transition hover:brightness-110 active:scale-[0.97] disabled:cursor-default disabled:opacity-45 disabled:hover:brightness-100 disabled:active:scale-100",
              focusRing,
            )}
          >
            {saving ? "Saving…" : "Save agents"}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-9 pr-2">
        <div className="mb-7 rounded-xl border border-black/[0.07] bg-black/[0.02] p-4 dark:border-white/[0.08] dark:bg-black/20">
          <div className="mb-3 text-[11px] font-semibold tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
            TERMINAL PANEL PREVIEW
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="grid h-8 place-items-center rounded-md bg-black/[0.06] px-2.5 text-[12.5px] font-medium text-neutral-800 dark:bg-white/10 dark:text-neutral-100">
              Terminal
            </span>
            <span className="mx-1 h-4 w-px bg-black/10 dark:bg-white/10" />
            {previewAgents.map((a) => (
              <PreviewAgent
                key={a.id}
                agent={a}
                availability={previewAvailability(a, savedAgents.get(a.id), checks[a.id])}
              />
            ))}
            {previewAgents.length === 0 && (
              <span className="text-[12.5px] italic text-neutral-400 dark:text-neutral-500">
                No agents enabled
              </span>
            )}
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-3 text-[12.5px] text-rose-600 dark:text-rose-400">
            {error}
          </div>
        )}

        {!error && draft.length === 0 && !loading && (
          <div className="rounded-xl border border-black/[0.07] bg-black/[0.02] p-5 text-[13px] leading-relaxed text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-neutral-400">
            No agents configured. Click <span className="font-semibold">Add agent</span>, or reset to
            the built-ins.
          </div>
        )}

        <div className="flex flex-col gap-1">
          {draft.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              editing={editor.isEditing(agent.id)}
              check={editor.checkOf(agent)}
              dragging={draggingId === agent.id}
              registerEl={registerEl(agent.id)}
              onHandleDown={startDrag(agent.id)}
              onEdit={() => editor.startEdit(agent.id)}
              onDone={() => editor.stopEdit(agent.id)}
              onToggleEnabled={() => editor.update(agent.id, { enabled: !agent.enabled })}
              onNameChange={(value) => editor.update(agent.id, { name: value })}
              onCommandChange={(value) => editor.editCommand(agent.id, value)}
              onDescriptionChange={(value) => editor.update(agent.id, { description: value })}
              onCheck={() => void editor.checkAgent(agent.id)}
              onDuplicate={() => editor.duplicate(agent.id)}
              onDelete={() => editor.confirmDelete(agent)}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={editor.add}
          className={cn(
            "mt-1.5 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-black/15 text-[13.5px] font-medium text-neutral-500 hover:border-black/25 hover:text-neutral-700 dark:border-white/15 dark:text-neutral-400 dark:hover:border-white/25 dark:hover:text-neutral-200",
            focusRing,
          )}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-4 w-4">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add agent
        </button>

      </div>
    </div>
  );
}

function PreviewAgent({
  agent,
  availability,
}: {
  agent: TerminalAgent;
  availability: PreviewAvailability;
}) {
  const title =
    availability === "available"
      ? agent.description || agent.name
      : availability === "missing"
        ? `${agent.command} was not found on PATH`
        : `Check ${agent.command} to verify PATH availability`;
  return (
    <span
      title={title}
      className={cn(
        "grid h-8 place-items-center rounded-md px-2.5 text-[12.5px] font-medium",
        availability === "available"
          ? "cursor-pointer text-neutral-600 hover:bg-black/[0.05] dark:text-neutral-300 dark:hover:bg-white/10"
          : availability === "missing"
            ? "cursor-not-allowed text-neutral-300 dark:text-neutral-600"
            : "border border-dashed border-black/10 text-neutral-400 dark:border-white/10 dark:text-neutral-500",
      )}
    >
      {agent.name}
    </span>
  );
}
