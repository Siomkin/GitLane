import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { DEFAULT_COMMIT_AGENT_MESSAGES } from "@/store/commitAgentMessages";
import { useCommitAgentMessagesDraft } from "./useCommitAgentMessagesDraft";

export function CommitAgentMessagesSettings() {
  const editor = useCommitAgentMessagesDraft();
  const saveDisabled = !editor.dirty || !editor.valid || editor.saving || editor.loading;

  return (
    <section className="mt-7 rounded-xl border border-black/[0.07] bg-black/[0.02] p-4 dark:border-white/[0.08] dark:bg-black/20">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
            Commit agent messages
          </h3>
          <p className="mt-1 max-w-[580px] text-[12.5px] leading-5 text-neutral-500 dark:text-neutral-400">
            Customize the instructions used by Draft / Improve and Commit with agent. GitLane
            always appends selected-file safety and draft-delivery instructions.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void editor.save()}
            disabled={saveDisabled}
            className={cn(
              "h-8 rounded-lg bg-[var(--accent)] px-3.5 text-[12.5px] font-semibold text-white shadow-sm transition hover:brightness-110 active:scale-[0.97] disabled:cursor-default disabled:opacity-45 disabled:hover:brightness-100 disabled:active:scale-100",
              focusRing,
            )}
          >
            {editor.saving ? "Saving…" : "Save messages"}
          </button>
        </div>
      </div>

      {editor.error && (
        <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-600 dark:text-rose-400">
          {editor.error}
        </div>
      )}

      <div className="mt-4 grid gap-3">
        <div className="grid gap-1.5 text-[12px] font-medium text-neutral-600 dark:text-neutral-300">
          <span className="flex items-center justify-between gap-3">
            <label htmlFor="commit-agent-draft-instruction">Draft / improve instruction</label>
            <ResetFieldButton
              label="Draft / improve instruction"
              disabled={
                editor.saving ||
                editor.loading ||
                editor.draft.draftInstruction ===
                  DEFAULT_COMMIT_AGENT_MESSAGES.draftInstruction
              }
              onClick={() => editor.resetField("draftInstruction")}
            />
          </span>
          <textarea
            id="commit-agent-draft-instruction"
            aria-label="Draft / improve instruction"
            value={editor.draft.draftInstruction}
            onChange={(event) => editor.update("draftInstruction", event.target.value)}
            className={cn(
              "min-h-20 resize-y rounded-lg border border-black/10 bg-white px-3 py-2.5 text-[12.5px] font-normal leading-5 text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-[color:var(--accent)] dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-100",
              focusRing,
            )}
          />
        </div>
        <div className="grid gap-1.5 text-[12px] font-medium text-neutral-600 dark:text-neutral-300">
          <span className="flex items-center justify-between gap-3">
            <label htmlFor="commit-agent-commit-instruction">Commit instruction</label>
            <ResetFieldButton
              label="Commit instruction"
              disabled={
                editor.saving ||
                editor.loading ||
                editor.draft.commitInstruction ===
                  DEFAULT_COMMIT_AGENT_MESSAGES.commitInstruction
              }
              onClick={() => editor.resetField("commitInstruction")}
            />
          </span>
          <textarea
            id="commit-agent-commit-instruction"
            aria-label="Commit instruction"
            value={editor.draft.commitInstruction}
            onChange={(event) => editor.update("commitInstruction", event.target.value)}
            className={cn(
              "min-h-20 resize-y rounded-lg border border-black/10 bg-white px-3 py-2.5 text-[12.5px] font-normal leading-5 text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-[color:var(--accent)] dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-100",
              focusRing,
            )}
          />
        </div>
      </div>
    </section>
  );
}

function ResetFieldButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`Reset ${label}`}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-md px-2 py-1 text-[11.5px] font-semibold text-neutral-500 transition hover:bg-black/[0.05] hover:text-neutral-800 disabled:cursor-default disabled:opacity-35 dark:text-neutral-400 dark:hover:bg-white/[0.06] dark:hover:text-neutral-200",
        focusRing,
      )}
    >
      Reset to default
    </button>
  );
}
