// The "AI Agents" settings panel: the agents that answer in-app requests
// (Draft / Improve a commit message, Describe changes) by speaking ACP.
//
// Layout follows AI Agents Redesign 1a — configured agents first, the full
// catalogue folded into a searchable Add picker underneath, sticky save bar.

import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { useListReorder } from "@/components/ui/useListReorder";
import { AiAgentRow } from "./AiAgentRow";
import { SupportedAgentsCard } from "./SupportedAgentsCard";
import { useAiAgentDraft } from "./useAiAgentDraft";

export function AiAgentsSettings() {
  const editor = useAiAgentDraft();
  const { draft, error, saving, dirty, valid } = editor;
  // Order is meaningful: it is the order Draft / Improve / Describe offer them.
  const layoutKey = draft.map((a) => `${a.id}${editor.isEditing(a.id) ? "*" : ""}`).join(" ");
  const { draggingId, registerEl, startDrag } = useListReorder(
    draft.map((a) => a.id),
    editor.move,
    layoutKey,
  );

  const firstEnabledId = draft.find((a) => a.enabled)?.id ?? null;
  const saveDisabled = !dirty || !valid || saving;

  return (
    <div className="flex h-full w-full flex-col">
      <div className="-mx-1 flex-none bg-white px-1 pb-5 pt-1 dark:bg-neutral-800">
        <h2 className="text-[28px] font-bold tracking-tight text-neutral-900 dark:text-white">
          AI Agents
        </h2>
        <p className="mt-2 max-w-[820px] text-[14px] leading-relaxed text-pretty text-neutral-500 dark:text-neutral-400">
          Agents draft commit messages and describe changes inside GitLane. They drive a CLI you
          are already signed in to, over the{" "}
          <span className="text-neutral-600 dark:text-neutral-300">Agent Client Protocol</span> — no
          API key.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-6 pr-2">
        <div className="mb-3 flex items-center gap-2">
          <span className="text-[11px] font-semibold tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
            IN USE
          </span>
          <span className="grid h-[18px] place-items-center rounded-full bg-black/[0.06] px-1.5 text-[11px] font-semibold tabular-nums text-neutral-500 dark:bg-white/10 dark:text-neutral-400">
            {draft.length}
          </span>
          <span className="ml-auto text-[12.5px] text-neutral-400 dark:text-neutral-500">
            Drag to reorder · first enabled agent is the default
          </span>
        </div>

        {error && (
          <div className="mb-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-3 text-[12.5px] text-rose-600 dark:text-rose-400">
            {error}
          </div>
        )}

        {draft.length === 0 ? (
          <div className="mb-8 rounded-xl border border-black/[0.07] bg-black/[0.02] p-5 text-[13px] leading-relaxed text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-neutral-400">
            No AI agents yet. Add one from the catalogue below and the Draft, Improve and AI actions
            actions will offer it.
          </div>
        ) : (
          <div className="mb-8 flex flex-col gap-1.5">
            {draft.map((agent) => (
              <AiAgentRow
                key={agent.id}
                agent={agent}
                adapters={editor.adapters}
                isDefault={agent.enabled && agent.id === firstEnabledId}
                editing={editor.isEditing(agent.id)}
                dragging={draggingId === agent.id}
                registerEl={registerEl(agent.id)}
                onHandleDown={startDrag(agent.id)}
                onChange={(patch) => editor.update(agent.id, patch)}
                onEdit={() => editor.startEdit(agent.id)}
                onDone={() => editor.stopEdit(agent.id)}
                onConnect={() => void editor.connect(agent.id)}
                onAddAnother={() => editor.addAnother(agent.id)}
                onDelete={() => editor.confirmDelete(agent)}
              />
            ))}
          </div>
        )}

        <SupportedAgentsCard
          addedCommands={new Set(draft.map((agent) => agent.command.trim()).filter(Boolean))}
          onAdd={editor.addFromAdapter}
          onAddCustom={editor.addCustom}
        />
      </div>

      <div
        className={cn(
          "-mx-9 flex h-16 shrink-0 items-center gap-3 border-t px-9 transition-colors",
          dirty
            ? "border-[color:var(--accent)]/20 bg-[var(--accent-soft)]"
            : "border-black/[0.06] bg-black/[0.02] dark:border-white/[0.06] dark:bg-black/20",
        )}
      >
        <span className="text-[13px] text-neutral-500 dark:text-neutral-400">
          {dirty ? "Unsaved changes" : "Changes apply to every repository"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
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
            type="button"
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
    </div>
  );
}
