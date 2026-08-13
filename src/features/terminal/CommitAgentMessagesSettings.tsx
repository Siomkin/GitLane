import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { isMac } from "@/lib/platform";
import { ShortcutId, formatShortcut } from "@/lib/shortcuts";
import { focusRing } from "@/lib/ui";
import { useListReorder } from "@/components/ui/useListReorder";
import { AiActionCommandRow } from "@/features/agents/ai-actions/AiActionCommandRow";
import { isBuiltinAiAction } from "@/features/agents/ai-actions/aiActionDraft";
import { COMMIT_PROMPT_ID, useCommitAgentMessagesDraft } from "./useCommitAgentMessagesDraft";

export function CommitAgentMessagesSettings() {
  const editor = useCommitAgentMessagesDraft();
  const layoutKey = [
    editor.isEditing(COMMIT_PROMPT_ID) ? "c*" : "c",
    ...editor.draft.aiActions.map((command) => `${command.id}${editor.isEditing(command.id) ? "*" : ""}`),
  ].join(" ");
  const { draggingId, registerEl, startDrag } = useListReorder(
    editor.draft.aiActions.map((command) => command.id),
    editor.moveCommand,
    layoutKey,
    () => {
      void editor.persistNow();
    },
  );

  const commitCommand = {
    id: COMMIT_PROMPT_ID,
    title: "Commit message",
    instruction: editor.draft.draftInstruction,
    enabled: true,
  };

  return (
    <div className="grid gap-7">
      {editor.error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-600 dark:text-rose-400">
          {editor.error}
        </div>
      )}

      <PromptSection title="Commit message" hint="Draft, Improve, and Commit with agent share this prompt. Always on — it cannot be hidden.">
        <AiActionCommandRow
          command={commitCommand}
          editing={editor.isEditing(COMMIT_PROMPT_ID)}
          disabled={editor.loading}
          pinned
          onEdit={() => editor.startEdit(COMMIT_PROMPT_ID)}
          onSave={() => editor.saveEdit(COMMIT_PROMPT_ID)}
          onCancel={() => editor.cancelEdit(COMMIT_PROMPT_ID)}
          onInstruction={editor.update}
          onReset={() => editor.confirmReset(COMMIT_PROMPT_ID)}
          dirty={editor.isDirty(COMMIT_PROMPT_ID)}
          resetDisabled={editor.atShippedDefault(COMMIT_PROMPT_ID)}
        />
      </PromptSection>

      <PromptSection
        title="AI actions"
        hint={`Commands in the popup from the commit / WIP menu, Review all, and ${formatShortcut(ShortcutId.AiActions, isMac)}. Disable a built-in to hide it; add your own for repeats. Custom prompt is still typed at run time. Save keeps the prompt; Cancel discards it.`}
      >
        <div className="flex flex-col gap-1">
          {editor.draft.aiActions.map((command) => (
            <AiActionCommandRow
              key={command.id}
              command={command}
              editing={editor.isEditing(command.id)}
              dragging={draggingId === command.id}
              disabled={editor.loading}
              registerEl={registerEl(command.id)}
              onHandleDown={startDrag(command.id)}
              onEdit={() => editor.startEdit(command.id)}
              onSave={() => editor.saveEdit(command.id)}
              onCancel={() => editor.cancelEdit(command.id)}
              onToggleEnabled={() => editor.patchCommand(command.id, { enabled: !command.enabled }, true)}
              onTitle={(title) => editor.patchCommand(command.id, { title })}
              onInstruction={(instruction) => editor.patchCommand(command.id, { instruction })}
              onReset={isBuiltinAiAction(command.id) ? () => editor.confirmReset(command.id) : undefined}
              onDelete={isBuiltinAiAction(command.id) ? undefined : () => editor.confirmDelete(command)}
              dirty={editor.isDirty(command.id)}
              resetDisabled={editor.atShippedDefault(command.id)}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={editor.addCommand}
          className={cn(
            "mt-1.5 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-black/15 text-[13.5px] font-medium text-neutral-500 hover:border-black/25 hover:text-neutral-700 dark:border-white/15 dark:text-neutral-400 dark:hover:border-white/25 dark:hover:text-neutral-200",
            focusRing,
          )}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-4 w-4">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add command
        </button>
      </PromptSection>
    </div>
  );
}

function PromptSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-black/[0.07] bg-black/[0.02] p-4 dark:border-white/[0.08] dark:bg-black/20">
      <h3 className="text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">{title}</h3>
      <p className="mt-1 max-w-[580px] text-[12.5px] leading-5 text-neutral-500 dark:text-neutral-400">
        {hint}
      </p>
      <div className="mt-4 grid gap-3">{children}</div>
    </section>
  );
}
