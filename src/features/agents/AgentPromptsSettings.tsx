import { CommitAgentMessagesSettings } from "@/features/terminal/CommitAgentMessagesSettings";

export function AgentPromptsSettings() {
  return (
    <div className="flex h-full w-full flex-col">
      <div className="-mx-1 flex-none bg-white px-1 pb-5 pt-1 dark:bg-neutral-800">
        <h2 className="text-[28px] font-bold tracking-tight text-neutral-900 dark:text-white">
          Prompts
        </h2>
        <p className="mt-2 max-w-[820px] text-[14px] leading-relaxed text-pretty text-neutral-500 dark:text-neutral-400">
          The instructions in-app agents follow for Draft, Commit, and AI actions.
          Expand a row to edit, then Save or Cancel. Edits apply to every repository.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-9 pr-2">
        <CommitAgentMessagesSettings />
      </div>
    </div>
  );
}
