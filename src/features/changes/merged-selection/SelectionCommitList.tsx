import { initials } from "../../../lib/ui";
import { relativeCommitDate, type SelectionCommitRow } from "./mergedSelection";

/** The compact, scrollable list of the commits in a multi-commit selection
 * (newest first): author initials, summary, "<age> · <author>", short SHA. */
export function SelectionCommitList({ rows }: { rows: SelectionCommitRow[] }) {
  return (
    <div className="max-h-48 shrink-0 overflow-auto rounded-xl border border-black/5 dark:border-white/5">
      {rows.map((row) => (
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
    </div>
  );
}
