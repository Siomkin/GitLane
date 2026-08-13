import { cn } from "@/lib/cn";
import type { OperationFile } from "@/store/repo";
import type { AiRunState } from "./ai-resolve";
import { ConflictFileRow } from "./ConflictFileRow";

export const ConflictFileList = ({
  files,
  selected,
  aiStateFor,
  total,
  resolved,
  unresolved,
  canStageAll,
  oursSub,
  theirsSub,
  onSelect,
  onAcceptOurs,
  onAcceptTheirs,
  onStageAll,
}: {
  files: OperationFile[];
  selected: string | null;
  /** This file's agent run state, when it has one — a sweep can be working on
   * files the user never opened. */
  aiStateFor: (path: string) => AiRunState | undefined;
  total: number;
  resolved: number;
  unresolved: number;
  canStageAll: boolean;
  /** Operation-aware side labels (rebase inverts ours/theirs) for the quick
   * accept buttons, matching the main editor. */
  oursSub: string;
  theirsSub: string;
  onSelect: (path: string) => void;
  onAcceptOurs: (path: string) => void;
  onAcceptTheirs: (path: string) => void;
  onStageAll: () => void;
}) => {
  const progress = total > 0 ? Math.round((resolved / total) * 100) : 0;
  return (
    <aside className="flex w-[330px] shrink-0 flex-col overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:border-white/5 dark:bg-neutral-800">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-black/5 px-4 dark:border-white/5">
        <span className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">
          Conflicted files
        </span>
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-100 px-1.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-400/15 dark:text-amber-300">
          {unresolved}
        </span>
        <span className="ml-auto font-mono text-[11px] text-neutral-400">
          {resolved}/{total}
        </span>
      </div>
      <div className="flex-1 space-y-0.5 overflow-auto p-1.5">
        {files.map((file) => (
          <ConflictFileRow
            key={file.path}
            file={file}
            selected={file.path === selected}
            aiState={aiStateFor(file.path)}
            oursSub={oursSub}
            theirsSub={theirsSub}
            onOpen={() => onSelect(file.path)}
            onAcceptOurs={() => onAcceptOurs(file.path)}
            onAcceptTheirs={() => onAcceptTheirs(file.path)}
          />
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-black/5 px-3 py-2.5 dark:border-white/5">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
          <div
            style={{ width: `${progress}%` }}
            className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
          />
        </div>
        <button type="button"
          onClick={onStageAll}
          disabled={!canStageAll}
          className={cn(
            "h-7 rounded-md px-2.5 text-[11px] font-medium",
            canStageAll
              ? "bg-[var(--accent)] text-white hover:brightness-110"
              : "cursor-not-allowed bg-black/[0.06] text-neutral-400 dark:bg-white/10",
          )}
        >
          Stage all resolved
        </button>
      </div>
    </aside>
  );
};
