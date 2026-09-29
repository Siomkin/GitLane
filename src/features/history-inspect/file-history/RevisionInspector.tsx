import type { FileHistoryEntry } from "@/lib/api";
import { CommitSummaryCard } from "./CommitSummaryCard";
import { InspectorAction } from "./InspectorAction";

export function RevisionInspector({
  entry,
  filePath,
  onOpenCommit,
  onBlame,
}: {
  entry: FileHistoryEntry;
  filePath: string;
  onOpenCommit: () => void;
  onBlame: () => void;
}) {
  return (
    <div className="space-y-3.5 p-4">
      <CommitSummaryCard commit={entry} />
      <div className="h-px bg-black/5 dark:bg-white/5" />
      <div className="space-y-1.5">
        <InspectorAction onClick={onOpenCommit} label="Open this commit">
          <circle cx="12" cy="12" r="3" />
          <path d="M3 12h6M15 12h6" />
        </InspectorAction>
        <InspectorAction onClick={onBlame} label="Blame at this revision">
          <path d="M4 6h16M4 12h10M4 18h7" />
        </InspectorAction>
      </div>
      {entry.previousPath && (
        <div className="rounded-lg bg-black/[0.03] p-2.5 text-[11.5px] text-neutral-500 dark:bg-white/[0.04] dark:text-neutral-400">
          Renamed here from <span className="font-mono text-violet-600 dark:text-violet-300">{entry.previousPath}</span>.
          History follows the rename. <span className="font-mono text-neutral-400">{filePath}</span>
        </div>
      )}
    </div>
  );
}
