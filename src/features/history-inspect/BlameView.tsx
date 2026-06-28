import { useMemo } from "react";
import { useRepo } from "../../store/repo";
import { initials, oidColor, relativeTime, shortAge } from "./inspect";

/** Blame mode: line attribution (grouped by commit run) + a line inspector. */
export function BlameView() {
  const history = useRepo((s) => s.fileHistory);
  const selectBlameLine = useRepo((s) => s.selectBlameLine);
  const loadFileBlame = useRepo((s) => s.loadFileBlame);
  const revealCommit = useRepo((s) => s.revealCommit);

  const rows = useMemo(() => {
    const lines = history?.blame?.lines ?? [];
    let prev: string | null = null;
    return lines.map((line) => {
      const first = line.oid !== prev;
      prev = line.oid;
      return { line, first };
    });
  }, [history?.blame?.lines]);

  const selectedLine = useMemo(
    () => history?.blame?.lines.find((l) => l.oid === history.blameSelectedOid) ?? null,
    [history?.blame?.lines, history?.blameSelectedOid],
  );

  if (!history) return null;
  const blame = history.blame;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {blame?.truncated && (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-amber-500/15 bg-amber-500/[0.08] px-3 text-[12px] text-amber-700 dark:text-amber-300">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5 shrink-0">
              <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
            </svg>
            Large file — showing first {blame.lines.length} lines
            <span className="ml-auto font-mono text-[11px]">capped</span>
          </div>
        )}
        <div className="flex-1 overflow-auto">
          {history.blameLoading ? (
            <div className="space-y-1 p-2.5">
              {Array.from({ length: 14 }).map((_, i) => (
                <div key={i} className="shim h-[20px] rounded bg-black/[0.05] dark:bg-white/[0.06]" />
              ))}
            </div>
          ) : history.blameError ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-neutral-400">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-7 w-7 text-rose-400">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v5M12 16h.01" />
              </svg>
              <p className="text-[13px] font-medium text-neutral-600 dark:text-neutral-300">Couldn't compute blame</p>
              <p className="max-w-full truncate text-[12px]">{history.blameError}</p>
              <button
                onClick={() => void loadFileBlame(history.blameRevision ?? history.selectedOid, history.selectedPath)}
                className="mt-1 h-8 rounded-lg bg-[color:var(--accent)] px-3.5 text-[12px] font-semibold text-white hover:brightness-110"
              >
                Retry
              </button>
            </div>
          ) : blame?.binary ? (
            <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 text-center text-neutral-400">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-9 w-9">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="m21 15-5-5L5 21" />
              </svg>
              <p className="text-[13px] font-medium text-neutral-600 dark:text-neutral-300">
                Blame isn't available for binary files.
              </p>
              <p className="font-mono text-[12px]">{history.path}</p>
            </div>
          ) : !blame || blame.lines.length === 0 ? (
            <div className="grid h-full place-content-center text-sm text-neutral-400">Nothing to blame.</div>
          ) : (
            rows.map(({ line, first }) => {
              const selected = line.oid !== "" && line.oid === history.blameSelectedOid;
              return (
                <div
                  key={line.lineNo}
                  onClick={() => line.oid && selectBlameLine(line.oid)}
                  style={{ borderColor: line.oid ? oidColor(line.oid) : "transparent" }}
                  className={
                    "flex min-h-[22px] cursor-default items-stretch border-l-[3px] leading-[22px] " +
                    (selected
                      ? "bg-[var(--accent-soft)]"
                      : "hover:bg-black/[0.025] dark:hover:bg-white/[0.03]")
                  }
                >
                  <div className="flex w-[244px] shrink-0 items-center gap-2 self-center overflow-hidden px-2.5">
                    {first && (
                      <>
                        <span className="w-[56px] shrink-0 font-mono text-[11px] text-neutral-400 dark:text-neutral-500">
                          {line.shortOid}
                        </span>
                        <span className="flex-1 truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                          {line.authorName}
                        </span>
                        <span className="shrink-0 text-[11px] text-neutral-400">{shortAge(line.timestamp)}</span>
                      </>
                    )}
                  </div>
                  <span className="w-[46px] shrink-0 select-none self-center pr-3 text-right font-mono text-[11px] text-neutral-300 dark:text-neutral-600">
                    {line.lineNo}
                  </span>
                  <span className="codeln min-w-0 flex-1 self-center whitespace-pre pl-3 pr-4 font-mono text-[12.5px] text-neutral-700 dark:text-neutral-300">
                    {line.content || " "}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* blame inspector */}
      <div className="flex w-[300px] shrink-0 flex-col overflow-auto border-l border-black/5 dark:border-white/5">
        {selectedLine ? (
          <div className="space-y-3.5 p-4">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12px] text-neutral-400">{selectedLine.shortOid}</span>
              <button
                onClick={() => void navigator.clipboard?.writeText(selectedLine.oid)}
                className="h-7 rounded-md border border-black/10 px-2.5 text-[11.5px] font-medium text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
              >
                Copy SHA
              </button>
            </div>
            <p className="text-pretty text-[14px] font-semibold leading-snug">{selectedLine.subject || "(no subject)"}</p>
            <div className="flex items-center gap-2.5">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[color:var(--accent)] text-[11px] font-semibold text-white">
                {initials(selectedLine.authorName)}
              </div>
              <div className="min-w-0">
                <div className="truncate text-[12.5px] font-medium">{selectedLine.authorName}</div>
                <div className="text-[11px] text-neutral-400">{relativeTime(selectedLine.timestamp)}</div>
              </div>
            </div>
            <div className="h-px bg-black/5 dark:bg-white/5" />
            <div className="space-y-1.5">
              <button
                onClick={() => void revealCommit(selectedLine.oid)}
                className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/5"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-4 w-4 text-neutral-400">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M3 12h6M15 12h6" />
                </svg>
                Open this commit
              </button>
              <button
                onClick={() => void loadFileBlame(`${selectedLine.oid}^`, selectedLine.originalPath)}
                className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/5"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-4 w-4 text-neutral-400">
                  <path d="M12 8v4l3 2" />
                  <circle cx="12" cy="12" r="9" />
                </svg>
                Blame previous revision
              </button>
            </div>
          </div>
        ) : (
          <div className="grid h-full place-items-center px-6 text-center">
            <p className="text-[12.5px] text-neutral-400">Select a line to see the commit that last changed it.</p>
          </div>
        )}
      </div>
    </div>
  );
}
