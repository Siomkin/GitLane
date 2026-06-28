import { useMemo } from "react";
import type { FileHistoryEntry } from "../../lib/api";
import { basename } from "../../lib/paths";
import { cn } from "../../lib/cn";
import { useRepo } from "../../store/repo";
import { StatusBadge, StatusPill } from "@/components/ui/StatusBadge";
import { UnifiedDiffBody } from "../review/DiffBody";
import { initials, relativeTime } from "./inspect";

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
    () => history?.entries.find((e) => e.oid === history.selectedOid) ?? null,
    [history?.entries, history?.selectedOid],
  );

  if (!history) return null;

  const deletedEntry = history.entries.find((e) => e.status === "D") ?? null;

  return (
    <div className="flex min-h-0 flex-1">
      {/* revisions */}
      <div className="flex w-[320px] shrink-0 flex-col border-r border-black/5 dark:border-white/5">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-black/5 px-3 text-[11px] font-semibold uppercase tracking-wider text-neutral-400 dark:border-white/5">
          <span>Revisions</span>
          <span className="font-mono normal-case tracking-normal text-neutral-300 dark:text-neutral-600">
            {history.loading ? "" : `${history.entries.length}${history.truncated ? "+" : ""}`}
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
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-neutral-400">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-7 w-7">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" />
              </svg>
              <p className="text-[13px]">No commits changed this path.</p>
            </div>
          ) : (
            <>
              {deletedEntry && (
                <div className="m-2 mb-1 flex items-start gap-2 rounded-lg border border-rose-500/15 bg-rose-500/[0.07] p-2.5 text-rose-600 dark:text-rose-300">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="mt-px h-4 w-4 shrink-0">
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  </svg>
                  <span className="text-[11.5px] leading-snug">
                    Deleted in <span className="font-mono">{deletedEntry.shortOid}</span> · history shown up to deletion
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
                onClick={() => onBlameRevision(selected.oid, selected.path)}
                className="h-7 rounded-md border border-black/10 px-2.5 text-[11.5px] font-medium text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
              >
                Blame at this revision
              </button>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-auto">
          <DiffPane />
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

function DiffPane() {
  const history = useRepo((s) => s.fileHistory);
  const selectRevision = useRepo((s) => s.selectFileHistoryRevision);
  if (!history) return null;
  if (history.diffLoading) {
    return (
      <div className="space-y-1.5 p-3.5">
        {[60, 80, 50, 70, 90, 40, 75, 55, 85, 65].map((w, i) => (
          <div key={i} className="shim h-[18px] rounded bg-black/[0.05] dark:bg-white/[0.06]" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  }
  const diff = history.selectedDiff;
  if (!diff) {
    if (history.error) {
      return (
        <div className="grid h-full place-content-center px-6 text-center text-sm text-rose-500">
          {history.error}
        </div>
      );
    }
    return <div className="grid h-full place-content-center text-sm text-neutral-400">Select a revision.</div>;
  }
  if (diff.binary) {
    return <div className="grid h-full place-content-center text-sm text-neutral-400">Binary file — no text diff.</div>;
  }
  return (
    <div className="p-3.5">
      <UnifiedDiffBody hunks={diff.hunks} />
      {diff.truncated && history.selectedOid && (
        <TruncatedNotice
          onShowFull={() => void selectRevision(history.selectedOid!, history.selectedPath, true)}
        />
      )}
    </div>
  );
}

/** Banner + action shown when the backend capped a diff at DIFF_LINE_LIMIT. */
export function TruncatedNotice({ onShowFull }: { onShowFull: () => void }) {
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg border border-amber-500/15 bg-amber-500/[0.08] px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5 shrink-0">
        <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      </svg>
      Diff capped for performance.
      <button
        onClick={onShowFull}
        className="ml-auto h-7 rounded-md border border-amber-500/30 px-2.5 text-[11.5px] font-semibold hover:bg-amber-500/10"
      >
        Show full diff
      </button>
    </div>
  );
}

function RevisionRow({
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

function RevisionInspector({
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

function InspectorAction({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/5"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-4 w-4 text-neutral-400">
        {children}
      </svg>
      {label}
    </button>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-neutral-400">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-7 w-7 text-rose-400">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16h.01" />
      </svg>
      <p className="text-[13px] font-medium text-neutral-600 dark:text-neutral-300">Couldn't load history</p>
      <p className="max-w-full truncate text-[12px]">{message}</p>
      <button
        onClick={onRetry}
        className="mt-1 h-8 rounded-lg bg-[color:var(--accent)] px-3.5 text-[12px] font-semibold text-white hover:brightness-110"
      >
        Retry
      </button>
    </div>
  );
}
