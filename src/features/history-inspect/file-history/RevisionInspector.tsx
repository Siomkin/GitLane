import type { FileHistoryEntry } from "../../../lib/api";
import { initials } from "../../../lib/ui";
import { relativeTime } from "../inspect";
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
  const copy = (text: string) => void navigator.clipboard?.writeText(text);
  return (
    <div className="space-y-3.5 p-4">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12px] text-neutral-400">{entry.shortOid}</span>
        <button
          onClick={() => copy(entry.oid)}
          className="h-7 rounded-md border border-black/10 px-2.5 text-[11.5px] font-medium text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
        >
          Copy SHA
        </button>
      </div>
      <p className="text-pretty text-[14px] font-semibold leading-snug">{entry.subject || "(no subject)"}</p>
      <div className="flex items-center gap-2.5">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[color:var(--accent)] text-[11px] font-semibold text-white">
          {initials(entry.authorName)}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[12.5px] font-medium">{entry.authorName}</div>
          <div className="text-[11px] text-neutral-400">{relativeTime(entry.timestamp)}</div>
        </div>
      </div>
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
