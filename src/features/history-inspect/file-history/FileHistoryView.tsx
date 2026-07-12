import { useMemo } from "react";
import { basename } from "@/lib/paths";
import { useRepo } from "@/store/repo";
import { StatusPill } from "@/components/ui/StatusBadge";
import { DiffPane } from "@/features/history-inspect/DiffPane";
import { deletedEntry, revisionCountLabel, selectedEntry } from "./fileHistoryModel";
import { RevisionRow } from "./RevisionRow";
import { RevisionInspector } from "./RevisionInspector";
import { ErrorState, EmptyState } from "./ErrorState";

/** File-history mode: revision list + selected-revision diff + inspector. */
export function FileHistoryView({
  onBlameRevision,
}: {
  onBlameRevision: (oid: string, path: string) => void;
}) {
  const history = useRepo((s) => s.fileHistory);
  const selectRevision = useRepo((s) => s.selectFileHistoryRevision);
  const loadMore = useRepo((s) => s.loadMoreFileHistory);
  const openFileHistory = useRepo((s) => s.openFileHistory);
  const revealCommit = useRepo((s) => s.revealCommit);

  const selected = useMemo(
    () => selectedEntry(history?.entries ?? [], history?.selectedOid ?? null),
    [history?.entries, history?.selectedOid],
  );

  if (!history) return null;

  const deleted = deletedEntry(history.entries);

  return (
    <div className="flex min-h-0 flex-1">
      {/* revisions */}
      <div className="flex w-[320px] shrink-0 flex-col border-r border-black/5 dark:border-white/5">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-black/5 px-3 text-[11px] font-semibold uppercase tracking-wider text-neutral-400 dark:border-white/5">
          <span>Revisions</span>
          <span className="font-mono normal-case tracking-normal text-neutral-300 dark:text-neutral-600">
            {revisionCountLabel(history.entries.length, history.truncated, history.loading)}
          </span>
        </div>
        <div className="flex-1 overflow-auto">
          {history.loading ? (
            <div className="space-y-1.5 p-2">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="shim h-[58px] rounded-lg bg-black/[0.05] dark:bg-white/[0.06]" />
              ))}
            </div>
          ) : history.error && history.entries.length === 0 ? (
            <ErrorState message={history.error} onRetry={() => void openFileHistory(history.path)} />
          ) : history.entries.length === 0 ? (
            <EmptyState />
          ) : (
            <>
              {deleted && (
                <div className="m-2 mb-1 flex items-start gap-2 rounded-lg border border-rose-500/15 bg-rose-500/[0.07] p-2.5 text-rose-600 dark:text-rose-300">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="mt-px h-4 w-4 shrink-0">
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  </svg>
                  <span className="text-[11.5px] leading-snug">
                    Deleted in <span className="font-mono">{deleted.shortOid}</span> · history shown up to deletion
                  </span>
                </div>
              )}
              <div className="space-y-0.5 p-1.5">
                {history.entries.map((entry) => (
                  <RevisionRow
                    key={entry.oid}
                    entry={entry}
                    active={entry.oid === history.selectedOid}
                    onSelect={() => void selectRevision(entry.oid, entry.path)}
                  />
                ))}
                {history.hasMore && (
                  <button
                    type="button"
                    className="mt-1 h-9 w-full rounded-lg border border-dashed border-black/10 text-[12px] font-medium text-neutral-500 hover:bg-black/5 disabled:opacity-60 dark:border-white/10 dark:text-neutral-400 dark:hover:bg-white/5"
                    disabled={history.loadingMore}
                    onClick={() => void loadMore()}
                  >
                    {history.loadingMore ? "Loading…" : `Load more · showing ${history.entries.length}`}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* selected-revision diff */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-black/5 px-4 dark:border-white/5">
          <span className="truncate text-[13px] font-semibold">{basename(history.path)}</span>
          {selected && <StatusPill status={selected.status} />}
          {selected && (
            <span className="font-mono text-[12px]">
              <span className="text-[color:var(--accent)]">+{selected.add}</span>{" "}
              <span className="text-rose-500">−{selected.del}</span>
            </span>
          )}
          {selected && (
            <div className="ml-auto flex items-center gap-2">
              <span className="font-mono text-[11px] text-neutral-400">at {selected.shortOid}</span>
              <button
                type="button"
                onClick={() => onBlameRevision(selected.oid, selected.path)}
                className="h-7 rounded-md border border-black/10 px-2.5 text-[11.5px] font-medium text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
              >
                Blame at this revision
              </button>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-auto">
          <DiffPane
            loading={history.diffLoading}
            diff={history.selectedDiff}
            error={history.error}
            emptyLabel="Select a revision."
            onShowFull={
              history.selectedOid
                ? () => void selectRevision(history.selectedOid!, history.selectedPath, true)
                : undefined
            }
          />
        </div>
      </div>

      {/* revision inspector */}
      <div className="flex w-[300px] shrink-0 flex-col overflow-auto border-l border-black/5 dark:border-white/5">
        {selected && (
          <RevisionInspector
            entry={selected}
            filePath={history.path}
            onOpenCommit={() => void revealCommit(selected.oid)}
            onBlame={() => onBlameRevision(selected.oid, selected.path)}
          />
        )}
      </div>
    </div>
  );
}
