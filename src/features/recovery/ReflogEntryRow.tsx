import type { ReflogEntry } from "@/lib/api";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { recoveryBranchName, reflogLabel, reflogTime } from "./reflogViewModel";

export const ReflogEntryRow = ({
  entry,
  onBranch,
  onCheckout,
}: {
  entry: ReflogEntry;
  onBranch: (entry: ReflogEntry, defaultName: string) => void;
  onCheckout: (entry: ReflogEntry) => void;
}) => {
  const label = reflogLabel(entry);
  const time = reflogTime(entry);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-black/5 px-4 py-3 last:border-b-0 dark:border-white/5">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded-md bg-black/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-neutral-600 dark:bg-white/[0.06] dark:text-neutral-300">
            {entry.shortOid}
          </span>
          <span className="truncate text-[13px] font-medium text-neutral-800 dark:text-neutral-100">
            {entry.subject || "Reflog entry"}
          </span>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-[11.5px] text-neutral-400">
          <span className="truncate">{label}</span>
          {time && <span className="shrink-0">{time}</span>}
          {entry.committerName && <span className="truncate">{entry.committerName}</span>}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <button type="button"
          className={cn(
            "h-7 rounded-md border border-black/10 px-2 text-[12px] font-medium text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5",
            focusRing,
          )}
          onClick={() => onBranch(entry, recoveryBranchName(entry))}
        >
          Branch
        </button>
        <button type="button"
          className={cn(
            "h-7 rounded-md border border-black/10 px-2 text-[12px] text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5",
            focusRing,
          )}
          onClick={() => onCheckout(entry)}
        >
          Checkout
        </button>
      </div>
    </div>
  );
};
