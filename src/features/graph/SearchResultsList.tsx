// The clickable commit-hit list shared by the advanced (repo-wide) search and
// the quick search's results panel. Purely presentational: rows are whatever
// the caller matched, clicking one hands the id back so each search owns its
// own reveal strategy (the quick search's hits are already in the loaded
// graph; the advanced search may have to page the graph first).

export interface SearchResultItem {
  id: string;
  shortId: string;
  summary: string;
  authorName: string;
}

/** Rendered row cap — keeps the non-virtualized panel cheap when a broad
 * query matches most of a large loaded graph. */
const MAX_RENDERED_RESULTS = 200;

export function SearchResultsList({
  results,
  onSelect,
  busyId,
  truncated,
  truncatedLabel,
}: {
  results: SearchResultItem[];
  onSelect: (id: string) => void;
  /** The id currently being revealed (rows disable while one is in flight). */
  busyId?: string | null;
  /** The result set itself was capped upstream (advanced search's page). */
  truncated?: boolean;
  truncatedLabel?: string;
}) {
  const visible = results.slice(0, MAX_RENDERED_RESULTS);
  const capped = results.length > visible.length;
  return (
    <div className="max-h-64 overflow-auto rounded-md border border-black/5 bg-white dark:border-white/5 dark:bg-neutral-900">
      {visible.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs text-neutral-400">No matching commits.</p>
      ) : (
        visible.map((result) => (
          <button
            key={result.id}
            type="button"
            disabled={busyId != null}
            onClick={() => onSelect(result.id)}
            className="flex w-full items-center gap-3 border-b border-black/5 px-3 py-2 text-left last:border-0 hover:bg-black/[0.03] disabled:opacity-60 dark:border-white/5 dark:hover:bg-white/[0.04]"
          >
            <code className="text-[10px] text-[color:var(--accent)]">{result.shortId}</code>
            <span className="min-w-0 flex-1 truncate text-xs text-neutral-700 dark:text-neutral-200">
              {result.summary || "(no message)"}
            </span>
            <span className="max-w-28 truncate text-[10px] text-neutral-400">{result.authorName}</span>
            {busyId === result.id && <span className="text-[10px] text-neutral-400">Loading…</span>}
          </button>
        ))
      )}
      {(truncated || capped) && (
        <p className="px-3 py-2 text-center text-[10px] text-neutral-400">
          {truncatedLabel ?? `Showing the first ${visible.length} matches.`}
        </p>
      )}
    </div>
  );
}
