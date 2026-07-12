import { initials } from "@/lib/ui";
import { relativeCommitDate, type SelectionCommitRow } from "./mergedSelection";

/** Upper bound on rendered commit rows. A shift-range can select thousands of
 * commits; this list is a secondary detail in a ~190px box, so cap the DOM
 * (rather than virtualize) and note the remainder. */
const ROW_CAP = 200;

/** The compact, scrollable list of the commits in a multi-commit selection
 * (newest first): author initials, summary, "<age> · <author>", short SHA. */
export function SelectionCommitList({ rows }: { rows: SelectionCommitRow[] }) {
  const shown = rows.length > ROW_CAP ? rows.slice(0, ROW_CAP) : rows;
  const hidden = rows.length - shown.length;
  return (
    <div className="max-h-48 shrink-0 overflow-auto rounded-xl border border-black/5 dark:border-white/5">
      {shown.map((row) => (
        <div
          key={row.id}
          className="flex items-center gap-2.5 border-b border-black/5 px-2.5 py-1.5 last:border-b-0 dark:border-white/5"
        >
          <div className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-[10px] font-semibold text-white">
            {initials(row.authorName)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] text-neutral-800 dark:text-neutral-100">{row.summary}</div>
            <div className="truncate text-[11px] text-neutral-400">
              {relativeCommitDate(row.timestamp)} · {row.authorName}
            </div>
          </div>
          <span className="shrink-0 font-mono text-[11px] text-neutral-400">{row.shortId}</span>
        </div>
      ))}
      {hidden > 0 && (
        <div className="px-2.5 py-1.5 text-[11px] text-neutral-400">+{hidden} more…</div>
      )}
    </div>
  );
}
