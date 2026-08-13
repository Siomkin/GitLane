import { SparkleIcon } from "@/components/ui/icons";
import { AiActionId, AiActionScopeKind } from "@/features/agents/ai-actions";
import { useUi } from "@/store/ui";

/** Staging-view entry to the shared AI actions popup — same surface as review-all
 *  and the commit/WIP menus, preselected to a short description of the working tree. */
export function ChangeSummaryCard() {
  const openAiActions = useUi((s) => s.openAiActions);
  return (
    <section
      aria-label="AI change description"
      className="flex items-center gap-2 border-b border-black/5 bg-white px-4 py-2.5 dark:border-white/5 dark:bg-neutral-800"
    >
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          AI description
        </div>
        <div className="text-[11px] text-neutral-400">Explain what these changes do</div>
      </div>
      <button
        type="button"
        className="ml-auto flex h-8 items-center gap-1.5 rounded-lg border border-black/10 px-2.5 text-[12px] font-medium text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
        onClick={() => openAiActions({ kind: AiActionScopeKind.Working, action: AiActionId.Short })}
      >
        <SparkleIcon className="h-3.5 w-3.5 text-[color:var(--accent)]" />
        AI actions
      </button>
    </section>
  );
}
