import type { AcpAgent, FileChange } from "@/lib/api";
import { ChevronDownIcon, CloseIcon, SparkleIcon } from "@/components/ui/icons";
import { AgentActionControl } from "@/features/changes/AgentActionControl";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { scopeIncludesWorking, scopeLabel, type AiActionScope } from "./aiActions";
import { AiActionMenu, markClass, type AiActionMenu as Menu } from "./aiActionsView";

export function AiActionsHeader({
  req,
  tally,
  files,
  commits,
  agents,
  agent,
  selectedAgentId,
  streaming,
  menu,
  onToggleMenu,
  onPickAgent,
  onClose,
}: {
  req: AiActionScope;
  tally: { stats: string; add: string; del: string } | null;
  files: FileChange[];
  commits: { oid: string; summary: string }[];
  agents: AcpAgent[];
  agent: AcpAgent | null;
  selectedAgentId: string;
  streaming: boolean;
  menu: Menu;
  onToggleMenu: (next: Menu) => void;
  onPickAgent: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <header className="relative flex h-[58px] shrink-0 items-center gap-3 border-b border-black/[0.07] pl-5 pr-4 dark:border-white/[0.07]">
      <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--accent-soft)] text-[color:var(--accent)]">
        <SparkleIcon className="h-4 w-4" />
      </span>
      <h2 id="ai-actions-title" className="shrink-0 text-[15px] font-semibold text-neutral-800 dark:text-white">
        AI actions
      </h2>
      <button
        type="button"
        onClick={() => onToggleMenu(menu === AiActionMenu.Scope ? AiActionMenu.None : AiActionMenu.Scope)}
        className={cn(
          "flex h-8 items-center gap-2 rounded-lg px-2.5 text-[12.5px]",
          menu === AiActionMenu.Scope
            ? "bg-black/[0.06] dark:bg-white/[0.09]"
            : "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]",
          focusRing,
        )}
      >
        <span className="whitespace-nowrap text-neutral-700 dark:text-neutral-200">{scopeLabel(req)}</span>
        {tally && (
          <>
            <span className="font-mono text-neutral-500">{tally.stats}</span>
            <span className="font-mono text-emerald-600 dark:text-emerald-400">{tally.add}</span>
            <span className="font-mono text-rose-500 dark:text-rose-400">{tally.del}</span>
          </>
        )}
        <ChevronDownIcon
          className={cn("h-3.5 w-3.5 text-neutral-500 transition-transform", menu === AiActionMenu.Scope && "rotate-180")}
        />
      </button>
      <div className="ml-auto flex items-center gap-2">
        <AgentActionControl
          variant="select"
          agents={agents}
          activeAgentId={selectedAgentId || null}
          label={agent?.name ?? "No agent"}
          buttonAriaLabel="Choose agent"
          menuLabel="Agent"
          placement="down"
          disabled={streaming}
          disabledTitle="Wait for the current run"
          onOpen={() => onToggleMenu(AiActionMenu.None)}
          onPick={(row) => onPickAgent(row.id)}
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className={cn(
            "grid h-8 w-8 place-items-center rounded-lg text-neutral-400 hover:bg-black/5 hover:text-neutral-600 dark:hover:bg-white/10 dark:hover:text-neutral-200",
            focusRing,
          )}
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      {menu === AiActionMenu.Scope && (
        <div className="gp-pop absolute top-[52px] left-[150px] z-30 max-h-[300px] w-[520px] overflow-y-auto rounded-xl border border-black/10 bg-white p-1.5 shadow-[0_18px_44px_-8px_rgba(0,0,0,0.5)] dark:border-white/10 dark:bg-neutral-800">
          {commits.map((commit) => (
            <div
              key={commit.oid}
              className="flex h-8 items-center gap-3 rounded-lg px-2 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            >
              <span className="shrink-0 font-mono text-[11.5px] text-neutral-500">{commit.oid.slice(0, 7)}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-600 dark:text-neutral-300">
                {commit.summary}
              </span>
            </div>
          ))}
          {scopeIncludesWorking(req) &&
            files.map((file) => (
              <div
                key={file.path}
                className="flex h-8 items-center gap-3 rounded-lg px-2 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
              >
                <span className={cn("w-4 text-center font-mono text-[11px] font-bold", markClass(file.status))}>
                  {file.status}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-neutral-600 dark:text-neutral-300">
                  {file.path}
                </span>
                <span className="shrink-0 font-mono text-[12px] text-neutral-500">
                  +{file.add} −{file.del}
                </span>
              </div>
            ))}
        </div>
      )}
    </header>
  );
}
