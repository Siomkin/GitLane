// The "Terminal Agents" settings panel: a CRUD + reorder editor for the user's
// terminal agents (the AI CLIs launched from the terminal panel). Rows are
// compact by default and expand into an inline editor on click; draft state,
// validation, and save/reset orchestration live in `useTerminalAgentDraft`, and
// each row is the presentational `AgentRow`. This container owns only the
// list-level view concerns: the pointer drag-to-reorder gesture and the FLIP
// reorder animation.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

  // Pointer-driven reorder: only the grip starts a drag (so inputs stay usable).
  // While dragging we reorder *live* — as the pointer crosses a row's midpoint,
  // the dragged agent moves into that slot and the FLIP effect glides every row
  // to its new position, so it's always obvious where the agent will land.
  const [dragId, setDragId] = useState<string | null>(null);

  // Refs read by the window-level pointer handlers, which are registered once
  // per drag and must see the latest draft / move fn without re-subscribing.
  const rowEls = useRef<Map<string, HTMLElement>>(new Map());
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const moveRef = useRef(editor.move);
  moveRef.current = editor.move;
  const dragIdRef = useRef<string | null>(null);
  // Everything needed to tear a drag down from any exit path: the window
  // listeners we attached plus the element/pointer we captured.
  const dragRef = useRef<{ detach: () => void; el: Element; pointerId: number } | null>(null);

  const endDrag = () => {
    const d = dragRef.current;
    if (d) {
      // Null out first so releasing capture (which re-fires `lostpointercapture`)
      // can't re-enter this teardown.
      dragRef.current = null;
      d.detach();
      if (d.el.hasPointerCapture?.(d.pointerId)) d.el.releasePointerCapture(d.pointerId);
    }
    dragIdRef.current = null;
    setDragId(null);
  };

  const onDragMove = (e: PointerEvent) => {
    const id = dragIdRef.current;
    if (id === null) return;
    const agents = draftRef.current;
    const from = agents.findIndex((a) => a.id === id);
    if (from < 0) return;
    // Target slot = number of rows whose midpoint the pointer has passed.
    let to = 0;
    for (let i = 0; i < agents.length; i++) {
      const el = rowEls.current.get(agents[i].id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (e.clientY > rect.top + rect.height / 2) to = i + 1;
    }
    if (to > from) to--;
    to = Math.max(0, Math.min(agents.length - 1, to));
    if (to !== from) moveRef.current(from, to);
  };

  const startDrag = (id: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget;
    const { pointerId } = e;
    dragIdRef.current = id;
    setDragId(id);
    // Capture the pointer so moves/ups keep flowing even if it leaves the grip
    // or the window, and end the drag on every terminal signal — normal release,
    // `pointercancel`, or a `lostpointercapture` from an OS gesture / alt-tab —
    // so a row can never stick in its lifted state. Capture is best-effort.
    try {
      el.setPointerCapture(pointerId);
    } catch {
      // ignore: drag still works via the window listeners below
    }
    const move = (ev: PointerEvent) => onDragMove(ev);
    const end = () => endDrag();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("lostpointercapture", end);
    dragRef.current = {
      el,
      pointerId,
      detach: () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        window.removeEventListener("lostpointercapture", end);
      },
    };
  };

  // Detach any live drag listeners if the panel unmounts mid-drag.
  useEffect(() => endDrag, []);

  // FLIP: glide rows to their new positions on reorder instead of snapping.
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
          el.style.transition = "transform 220ms cubic-bezier(0.2,0,0,1)";
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

  const previewAgents = draft.filter((a) => a.enabled && a.name.trim() && a.command.trim());
  const savedAgents = new Map(saved.map((agent) => [agent.id, agent]));
  const saveDisabled = !dirty || !valid || saving;

  return (
    <div className="flex h-full max-w-[860px] flex-col">
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
          <button
            onClick={editor.reset}
            disabled={saving}
            className={cn(
              "h-9 rounded-lg px-3.5 text-[13px] font-semibold text-neutral-500 transition hover:bg-black/[0.04] hover:text-neutral-800 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-white/[0.06] dark:hover:text-neutral-200",
              focusRing,
            )}
          >
            Reset to defaults
          </button>
          <button
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
              dragging={dragId === agent.id}
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

        <div className="mt-7 rounded-xl border border-black/[0.07] bg-black/[0.02] p-4 dark:border-white/[0.08] dark:bg-black/20">
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
