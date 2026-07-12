import type { FileHistoryEntry } from "@/lib/api";
import { cn } from "@/lib/cn";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { relativeTime } from "@/features/history-inspect/inspect";

export function RevisionRow({
  entry,
  active,
  onSelect,
}: {
  entry: FileHistoryEntry;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full space-y-1 rounded-lg px-2.5 py-2 text-left",
        active
          ? "bg-[var(--accent-soft)] shadow-[inset_3px_0_0_var(--accent)]"
          : "hover:bg-black/[0.035] dark:hover:bg-white/[0.04]",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusBadge status={entry.status} />
        <span className="flex-1 truncate text-[12.5px] text-neutral-800 dark:text-neutral-100">
          {entry.subject || "(no subject)"}
        </span>
      </div>
      {entry.previousPath && (
        <div className="flex items-center gap-1 text-[11px] text-violet-600 dark:text-violet-300">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3 w-3 shrink-0">
            <path d="M4 17v2a2 2 0 0 0 2 2h12M20 7V5a2 2 0 0 0-2-2H6" />
            <path d="m16 3 4 4-4 4M8 21l-4-4 4-4" />
          </svg>
          <span className="truncate">renamed from {entry.previousPath}</span>
        </div>
      )}
      <div className="flex items-center gap-2 text-[11px] text-neutral-400">
        <span className="font-mono">{entry.shortOid}</span>
        <span className="flex-1 truncate">{entry.authorName}</span>
        <span className="font-mono">
          <span className="text-[color:var(--accent)]">+{entry.add}</span>{" "}
          <span className="text-rose-500">−{entry.del}</span>
        </span>
        <span className="shrink-0">{relativeTime(entry.timestamp)}</span>
      </div>
    </button>
  );
}
