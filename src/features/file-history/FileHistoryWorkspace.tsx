import { useMemo, useState } from "react";
import type { FileHistoryEntry } from "../../lib/api";
import { basename, dirname } from "../../lib/paths";
import { cn } from "../../lib/cn";
import { useRepo } from "../../store/repo";
import { FileIcon } from "@/components/ui/icons";
import { StatusPill } from "@/components/ui/StatusBadge";
import { UnifiedDiffBody } from "../review/DiffBody";

type Mode = "history" | "blame";

export const FileHistoryWorkspace = () => {
  const history = useRepo((s) => s.fileHistory);
  const closeFileHistory = useRepo((s) => s.closeFileHistory);
  const loadMoreFileHistory = useRepo((s) => s.loadMoreFileHistory);
  const selectFileHistoryRevision = useRepo((s) => s.selectFileHistoryRevision);
  const loadFileBlame = useRepo((s) => s.loadFileBlame);
  const [mode, setMode] = useState<Mode>(history?.blameLoading ? "blame" : "history");

  const selectedEntry = useMemo(
    () => history?.entries.find((entry) => entry.oid === history.selectedOid) ?? null,
    [history?.entries, history?.selectedOid],
  );

  if (!history) return null;

  const switchMode = (nextMode: Mode) => {
    setMode(nextMode);
    if (nextMode === "blame" && !history.blame && !history.blameLoading) {
      void loadFileBlame(history.selectedOid);
    }
  };

  const selectRevision = (entry: FileHistoryEntry) => {
    void selectFileHistoryRevision(entry.oid, entry.path);
    if (mode === "blame") void loadFileBlame(entry.oid);
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:border-white/5 dark:bg-neutral-800">
      <div className="flex h-12 flex-none items-center gap-2.5 border-b border-black/5 px-4 dark:border-white/5">
        <span className="text-[color:var(--accent)]">
          <FileIcon path={history.path} size={20} />
        </span>
        <span className="text-[14px] font-semibold text-neutral-800 dark:text-neutral-100">
          {basename(history.path)}
        </span>
        <span className="min-w-0 truncate text-[12px] text-neutral-400">
          {dirname(history.path)}
        </span>
        <button
          className="ml-1 h-7 rounded-lg border border-black/10 px-2.5 text-[12px] font-medium text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
          onClick={() => copy(history.path)}
        >
          Copy path
        </button>
        {selectedEntry && (
          <button
            className="h-7 rounded-lg border border-black/10 px-2.5 font-mono text-[12px] font-medium text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
            onClick={() => copy(selectedEntry.oid)}
          >
            {selectedEntry.shortOid}
          </button>
        )}
        <div className="ml-auto flex rounded-lg bg-black/[0.06] p-0.5 text-[12px] dark:bg-white/[0.06]">
          <button className={modeButton(mode === "history")} onClick={() => switchMode("history")}>
            Diff
          </button>
          <button className={modeButton(mode === "blame")} onClick={() => switchMode("blame")}>
            Blame
          </button>
        </div>
        <button
          className="flex h-8 items-center gap-1 rounded-lg border border-black/10 px-2.5 text-[12px] font-medium text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
          onClick={closeFileHistory}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
            <path d="m15 18-6-6 6-6" />
          </svg>
          Back
        </button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-auto border-r border-black/5 bg-neutral-50/70 p-2 dark:border-white/5 dark:bg-neutral-900/35">
          {history.loading ? (
            <div className="grid h-full place-content-center text-sm text-neutral-400">Loading history...</div>
          ) : history.entries.length === 0 ? (
            <div className="grid h-full place-content-center px-4 text-center text-sm text-neutral-400">
              No commits changed this path in the bounded scan window.
            </div>
          ) : (
            <>
              <div className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                {history.entries.length} revision{history.entries.length === 1 ? "" : "s"}
                {history.truncated ? " (scan capped)" : ""}
              </div>
              <div className="space-y-1">
                {history.entries.map((entry) => (
                  <HistoryRow
                    key={entry.oid}
                    entry={entry}
                    active={entry.oid === history.selectedOid}
                    onSelect={() => selectRevision(entry)}
                  />
                ))}
              </div>
              {history.hasMore && (
                <button
                  className="mt-2 h-9 w-full rounded-lg border border-black/10 text-[12px] font-medium text-neutral-600 hover:bg-black/5 disabled:opacity-60 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
                  disabled={history.loadingMore}
                  onClick={() => void loadMoreFileHistory()}
                >
                  {history.loadingMore ? "Loading..." : "Load more"}
                </button>
              )}
            </>
          )}
        </aside>

        <section className="min-h-0 overflow-auto">
          {history.error && (
            <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
              {history.error}
            </div>
          )}
          {mode === "blame" ? <BlamePane /> : <DiffPane />}
        </section>
      </div>
    </main>
  );
};

const modeButton = (active: boolean) =>
  cn(
    "h-6 rounded-md px-2.5",
    active
      ? "bg-white font-medium text-neutral-800 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
      : "text-neutral-500 dark:text-neutral-400",
  );

const HistoryRow = ({
  entry,
  active,
  onSelect,
}: {
  entry: FileHistoryEntry;
  active: boolean;
  onSelect: () => void;
}) => {
  const date = new Date(entry.timestamp * 1000).toLocaleDateString();
  return (
    <button
      className={cn(
        "w-full rounded-lg border px-2.5 py-2 text-left",
        active
          ? "border-[color:var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,white)] dark:bg-[color-mix(in_srgb,var(--accent)_18%,#262626)]"
          : "border-transparent hover:bg-black/[0.04] dark:hover:bg-white/[0.05]",
      )}
      onClick={onSelect}
    >
      <div className="flex items-center gap-2">
        <StatusPill status={entry.status} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-800 dark:text-neutral-100">
          {entry.subject || "(no subject)"}
        </span>
        <span className="font-mono text-[11px] text-neutral-400">{entry.shortOid}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-neutral-400">
        <span className="min-w-0 flex-1 truncate">{entry.authorName}</span>
        <span>{date}</span>
      </div>
      {entry.previousPath && (
        <div className="mt-1 truncate text-[11px] text-amber-600 dark:text-amber-300">
          renamed from {entry.previousPath}
        </div>
      )}
    </button>
  );
};

const DiffPane = () => {
  const history = useRepo((s) => s.fileHistory);
  if (!history) return null;
  if (history.diffLoading) {
    return <div className="grid h-full place-content-center text-sm text-neutral-400">Loading diff...</div>;
  }
  if (!history.selectedDiff) {
    return <div className="grid h-full place-content-center text-sm text-neutral-400">Select a revision.</div>;
  }
  if (history.selectedDiff.binary) {
    return <div className="grid h-full place-content-center text-sm text-neutral-400">Binary file.</div>;
  }
  return <UnifiedDiffBody hunks={history.selectedDiff.hunks} file={history.selectedDiff.path} />;
};

const BlamePane = () => {
  const history = useRepo((s) => s.fileHistory);
  if (!history) return null;
  if (history.blameLoading) {
    return <div className="grid h-full place-content-center text-sm text-neutral-400">Loading blame...</div>;
  }
  if (!history.blame) {
    return <div className="grid h-full place-content-center text-sm text-neutral-400">Blame not loaded.</div>;
  }
  if (history.blame.binary) {
    return <div className="grid h-full place-content-center text-sm text-neutral-400">Binary file blame is unavailable.</div>;
  }
  return (
    <div className="min-w-max font-mono text-[12px] leading-[19px]">
      {history.blame.lines.map((line) => (
        <div key={line.lineNo} className="flex min-h-[19px] hover:bg-black/[0.04] dark:hover:bg-white/[0.05]">
          <span className="w-16 shrink-0 select-none border-r border-black/5 px-2 text-right text-neutral-400 dark:border-white/5">
            {line.lineNo}
          </span>
          <span className="w-20 shrink-0 px-2 text-[color:var(--accent)]">{line.shortOid}</span>
          <span className="w-44 shrink-0 truncate px-2 text-neutral-500 dark:text-neutral-400">
            {line.authorName}
          </span>
          <span className="min-w-[520px] flex-1 whitespace-pre px-3 text-neutral-800 dark:text-neutral-100">
            {line.content || " "}
          </span>
        </div>
      ))}
      {history.blame.truncated && (
        <div className="border-t border-black/5 px-4 py-2 text-xs text-neutral-400 dark:border-white/5">
          Blame output is capped. Narrow the file or open it in git for the full listing.
        </div>
      )}
    </div>
  );
};
