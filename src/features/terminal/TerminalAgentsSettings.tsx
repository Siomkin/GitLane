// The "Terminal" settings panel: a CRUD + reorder editor for the user's terminal
// agents (the AI CLIs launched from the terminal panel). Draft state, validation,
// and save/reset orchestration live in `useTerminalAgentDraft`; each row is the
// presentational `AgentRow`. This container owns only the list-level view
// concerns: the drag-to-reorder gesture and the FLIP reorder animation.

import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { focusRing } from "../../lib/ui";
import { type TerminalAgent } from "../../lib/api";
import { AgentRow } from "./AgentRow";
import { useTerminalAgentDraft } from "./useTerminalAgentDraft";
import { previewAvailability, type PreviewAvailability } from "./agentDraft";

// Re-export so existing importers (and tests) keep a single import site even
// though the implementation now lives in the pure-helper module.
export { previewAvailability } from "./agentDraft";

export function TerminalAgentsSettings() {
  const editor = useTerminalAgentDraft();
  const { draft, saved, loading, error, saving, dirty, valid, checks } = editor;

  // Native HTML5 drag-and-drop reorder. Only the handle is `draggable`, so text
  // inputs stay editable. We reorder *live* while dragging: as the pointer
  // crosses a row's midpoint, the dragged agent moves into that slot and the
  // FLIP effect glides every row to its new position — so it's always obvious
  // where the agent will land, and the move can't be "missed" on release.
  const [dragId, setDragId] = useState<string | null>(null);

  // FLIP: glide rows to their new positions on reorder instead of snapping.
  const rowEls = useRef<Map<string, HTMLElement>>(new Map());
  const prevRects = useRef<Map<string, DOMRect>>(new Map());
  useLayoutEffect(() => {
    const els = rowEls.current;
    els.forEach((el, id) => {
      const prev = prevRects.current.get(id);
      const next = el.getBoundingClientRect();
      const dy = prev ? prev.top - next.top : 0;
      if (dy) {
        el.style.transition = "none";
        el.style.transform = `translateY(${dy}px)`;
        void el.offsetHeight; // force reflow so the start position sticks
        requestAnimationFrame(() => {
          el.style.transition = "transform 220ms ease";
          el.style.transform = "";
        });
      }
    });
    const snapshot = new Map<string, DOMRect>();
    els.forEach((el, id) => snapshot.set(id, el.getBoundingClientRect()));
    prevRects.current = snapshot;
  }, [draft]);

  const registerEl = (id: string) => (el: HTMLElement | null) => {
    if (el) rowEls.current.set(id, el);
    else rowEls.current.delete(id);
  };

  const onRowDragOver = (agent: TerminalAgent, index: number) => (e: React.DragEvent) => {
    if (dragId === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragId === agent.id) return;
    const from = draft.findIndex((a) => a.id === dragId);
    if (from < 0) return;
    // Only swap once the pointer has crossed this row's midpoint in the
    // direction of travel — prevents jitter between two rows.
    const rect = e.currentTarget.getBoundingClientRect();
    const past = e.clientY > rect.top + rect.height / 2;
    if ((from < index && past) || (from > index && !past)) editor.move(from, index);
  };

  const previewAgents = draft.filter((a) => a.enabled && a.name.trim() && a.command.trim());
  const savedAgents = new Map(saved.map((agent) => [agent.id, agent]));
  const saveDisabled = !dirty || !valid || saving;
  const saveStatus = "Each agent needs a name and command.";

  return (
    <div className="flex h-full max-w-[860px] flex-col">
      <div className="-mx-1 flex flex-none items-center justify-between gap-4 bg-white px-1 pb-4 pt-1 dark:bg-neutral-800">
        <div className="min-w-0">
          <h2 className="text-[30px] font-bold tracking-tight text-neutral-900 dark:text-white">
            Terminal Agents
          </h2>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <div className="flex items-center gap-2">
            <button
              onClick={editor.reset}
              disabled={saving}
              className={cn(
                "h-9 px-3 rounded-lg text-[13px] font-medium text-neutral-500 dark:text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5 hover:text-neutral-800 dark:hover:text-neutral-200 disabled:opacity-40",
                focusRing,
              )}
            >
              Reset to defaults
            </button>
            <button
              disabled={saveDisabled}
              onClick={() => void editor.save()}
              className={cn(
                "h-9 px-4 rounded-lg text-[13px] font-semibold text-white bg-[var(--accent)] shadow-sm transition hover:brightness-110 active:scale-[0.97] disabled:opacity-45 disabled:cursor-default disabled:hover:brightness-100 disabled:active:scale-100",
                focusRing,
              )}
            >
              {saving ? "Saving..." : "Save agents"}
            </button>
          </div>
          {dirty && !valid && (
            <span
              className="text-[12px] text-amber-600 dark:text-amber-400"
            >
              {saveStatus}
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-9 pr-2">
        <p className="max-w-[520px] text-[13px] leading-relaxed text-neutral-500 text-pretty dark:text-neutral-400">
          The AI CLIs launched from the terminal panel. Drag to reorder, toggle to show or hide,
          and edit the command to pin a model or flags.
        </p>

        {error && (
          <div className="mt-6 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-3 text-[12.5px] text-rose-600 dark:text-rose-400">
            {error}
          </div>
        )}

        {!error && draft.length === 0 && !loading && (
          <div className="mt-6 rounded-xl border border-black/[0.07] bg-black/[0.02] p-5 text-[13px] leading-relaxed text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-neutral-400">
            No agents configured. Click <span className="font-semibold">Add agent</span>, or reset to
            the built-ins.
          </div>
        )}

        <div className="mt-7 flex flex-col gap-2.5">
          {draft.map((agent, i) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              check={editor.checkOf(agent)}
              isDragging={dragId === agent.id}
              registerEl={registerEl(agent.id)}
              onDragStart={(e) => {
                setDragId(agent.id);
                e.dataTransfer.effectAllowed = "move";
                const card = e.currentTarget.closest("[data-agent-card]");
                if (card instanceof HTMLElement) e.dataTransfer.setDragImage(card, 14, 14);
              }}
              onDragEnd={() => setDragId(null)}
              onDragOver={onRowDragOver(agent, i)}
              onDrop={(e) => {
                e.preventDefault();
                setDragId(null);
              }}
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
            "mt-2.5 flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-black/15 text-[13.5px] font-medium text-neutral-500 hover:border-black/25 hover:text-neutral-700 dark:border-white/15 dark:text-neutral-400 dark:hover:border-white/25 dark:hover:text-neutral-200",
            focusRing,
          )}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-4 w-4">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add agent
        </button>

        <div className="mt-8 rounded-xl border border-black/[0.07] bg-black/[0.02] p-4 dark:border-white/[0.08] dark:bg-black/20">
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
        "px-2.5 h-8 grid place-items-center rounded-md text-[12.5px] font-medium",
        availability === "available"
          ? "cursor-pointer text-neutral-600 hover:bg-black/[0.05] dark:text-neutral-300 dark:hover:bg-white/10"
          : availability === "missing"
            ? "text-neutral-300 dark:text-neutral-600 cursor-not-allowed"
            : "border border-dashed border-black/10 text-neutral-400 dark:border-white/10 dark:text-neutral-500",
      )}
    >
      {agent.name}
    </span>
  );
}
