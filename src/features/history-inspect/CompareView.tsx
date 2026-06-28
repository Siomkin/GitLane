import { useMemo } from "react";
import type { CompareScope } from "../../store/repoTypes";
import type { FileChange } from "../../lib/api";
import { basename, dirname } from "../../lib/paths";
import { cn } from "../../lib/cn";
import { useRepo } from "../../store/repo";
import { StatusBadge, StatusPill } from "@/components/ui/StatusBadge";
import { UnifiedDiffBody } from "../review/DiffBody";

/** Cap on rendered file rows so a huge compare result stays bounded in the DOM. */
const FILE_RENDER_CAP = 400;

const SCOPES: { key: CompareScope; label: string }[] = [
  { key: "upstream", label: "Upstream" },
  { key: "branch", label: "Branch" },
  { key: "commit", label: "Commit" },
  { key: "working", label: "Working" },
];

/** Compare mode: a range bar, the selected file's diff, and a filterable
 * changed-files list. */
export function CompareView() {
  const compare = useRepo((s) => s.compare);
  const selectFile = useRepo((s) => s.selectCompareFile);
  const setFilter = useRepo((s) => s.setComparePathFilter);
  const swap = useRepo((s) => s.swapCompare);

  const filtered = useMemo(() => {
    if (!compare) return [];
    const f = compare.pathFilter.trim().toLowerCase();
    return f ? compare.files.filter((file) => file.path.toLowerCase().includes(f)) : compare.files;
  }, [compare]);

  if (!compare) return null;

  const selected = compare.files.find((f) => f.path === compare.selectedPath) ?? null;
  const shown = filtered.slice(0, FILE_RENDER_CAP);
  const hasFilter = compare.pathFilter.trim().length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* range bar */}
      <div className="flex h-12 shrink-0 items-center gap-2 overflow-x-auto border-b border-black/5 px-3 dark:border-white/5">
        <span className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-black/[0.06] bg-black/[0.04] pl-1.5 pr-2.5 font-mono text-[12px] font-medium dark:border-white/[0.06] dark:bg-white/[0.06]">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3 w-3 text-neutral-400">
            <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.34 9.5 4 4 0 0 0 7 17.5" />
          </svg>
          {compare.baseLabel}
        </span>
        <button
          onClick={() => void swap()}
          disabled={compare.head === null}
          title={compare.head === null ? "Working-tree comparison can't be swapped" : "Swap direction"}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/5"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-4 w-4">
            <path d="m7 16 4 4 4-4M11 20V8M17 8 13 4 9 8M13 4v12" />
          </svg>
        </button>
        <span className="flex h-7 shrink-0 items-center gap-1 rounded-md bg-[color:var(--accent)] pl-1.5 pr-2.5 font-mono text-[12px] font-medium text-white">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3 w-3">
            <path d="M6 3v15M18 9a9 9 0 0 1-9 9" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
          </svg>
          {compare.headLabel}
        </span>
        <div className="ml-2 flex shrink-0 rounded-lg bg-black/[0.06] p-0.5 text-[11.5px] dark:bg-white/[0.06]">
          {SCOPES.map((s) => (
            <span
              key={s.key}
              className={cn(
                "h-6 whitespace-nowrap rounded-md px-2.5 leading-6",
                s.key === compare.scope
                  ? "bg-white font-medium text-neutral-800 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
                  : "text-neutral-400 dark:text-neutral-500",
              )}
            >
              {s.label}
            </span>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2.5">
          <span className="font-mono text-[12px]">
            <span className="text-[color:var(--accent)]">+{compare.add}</span>{" "}
            <span className="text-rose-500">−{compare.del}</span>
          </span>
          <span className="font-mono text-[12px] text-neutral-400">
            ↑{compare.ahead} ↓{compare.behind}
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* diff */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-black/5 px-4 dark:border-white/5">
            {selected ? (
              <>
                <span className="truncate text-[13px] font-semibold">{basename(selected.path)}</span>
                <span className="truncate text-[12px] text-neutral-400">{dirname(selected.path)}</span>
                <StatusPill status={selected.status} />
                <span className="ml-auto shrink-0 font-mono text-[12px]">
                  <span className="text-[color:var(--accent)]">+{selected.add}</span>{" "}
                  <span className="text-rose-500">−{selected.del}</span>
                </span>
              </>
            ) : (
              <span className="text-[12px] text-neutral-400">Select a file to view its diff.</span>
            )}
          </div>
          <div className="flex-1 overflow-auto">
            <DiffPane />
          </div>
        </div>

        {/* files */}
        <aside className="flex w-[336px] shrink-0 flex-col border-l border-black/5 dark:border-white/5">
          <div className="shrink-0 space-y-2 border-b border-black/5 p-2.5 dark:border-white/5">
            <div className="flex h-8 items-center gap-1.5 rounded-lg border border-black/[0.06] bg-black/[0.04] px-2.5 dark:border-white/[0.06] dark:bg-white/[0.06]">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5 shrink-0 text-neutral-400">
                <path d="M4 6h16M7 12h10M10 18h4" />
              </svg>
              <input
                value={compare.pathFilter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by path…"
                className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-neutral-400"
              />
              {hasFilter && (
                <button
                  onClick={() => setFilter("")}
                  className="grid h-5 w-5 shrink-0 place-items-center rounded text-neutral-400 hover:bg-black/10 dark:hover:bg-white/10"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
            <div className="flex items-center justify-between px-0.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
              <span>{hasFilter ? "Matching files" : "Changed files"}</span>
              <span className="font-mono normal-case tracking-normal">
                {hasFilter ? `${filtered.length} / ${compare.files.length}` : compare.files.length}
              </span>
            </div>
          </div>
          <div className="flex-1 space-y-0.5 overflow-auto p-1.5">
            {compare.loading ? (
              <div className="space-y-1.5 p-1">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="shim h-11 rounded-lg bg-black/[0.05] dark:bg-white/[0.06]" />
                ))}
              </div>
            ) : compare.error ? (
              <div className="px-3 py-6 text-center text-[12.5px] text-rose-500">{compare.error}</div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12.5px] text-neutral-400">
                {hasFilter ? `No files match "${compare.pathFilter}".` : "No changes between these endpoints."}
              </div>
            ) : (
              <>
                {filtered.length > FILE_RENDER_CAP && (
                  <div className="m-1 mb-1.5 flex items-center gap-2 rounded-lg border border-amber-500/15 bg-amber-500/[0.08] p-2 text-[11px] text-amber-700 dark:text-amber-300">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5 shrink-0">
                      <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                    </svg>
                    {filtered.length} files — showing first {FILE_RENDER_CAP}. Filter to narrow.
                  </div>
                )}
                {shown.map((file) => (
                  <CompareFileRow
                    key={file.path}
                    file={file}
                    active={file.path === compare.selectedPath}
                    onSelect={() => void selectFile(file.path)}
                  />
                ))}
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function DiffPane() {
  const compare = useRepo((s) => s.compare);
  if (!compare) return null;
  if (compare.diffLoading) {
    return (
      <div className="space-y-1.5 p-3.5">
        {[60, 80, 50, 70, 90, 40, 75, 55].map((w, i) => (
          <div key={i} className="shim h-[18px] rounded bg-black/[0.05] dark:bg-white/[0.06]" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  }
  const diff = compare.selectedDiff;
  if (!diff) {
    return <div className="grid h-full place-content-center text-sm text-neutral-400">Select a file.</div>;
  }
  if (diff.binary) {
    return <div className="grid h-full place-content-center text-sm text-neutral-400">Binary file — no text diff.</div>;
  }
  return (
    <div className="p-3.5">
      <UnifiedDiffBody hunks={diff.hunks} />
    </div>
  );
}

function CompareFileRow({
  file,
  active,
  onSelect,
}: {
  file: FileChange;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        "flex h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left",
        active
          ? "bg-[var(--accent-soft)] shadow-[inset_3px_0_0_var(--accent)]"
          : "hover:bg-black/5 dark:hover:bg-white/5",
      )}
    >
      <StatusBadge status={file.status} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] text-neutral-800 dark:text-neutral-100">{basename(file.path)}</div>
        <div className="truncate text-[10.5px] text-neutral-400">{dirname(file.path)}</div>
      </div>
      <span className="shrink-0 font-mono text-[11px]">
        <span className="text-[color:var(--accent)]">+{file.add}</span>{" "}
        <span className="text-rose-500">−{file.del}</span>
      </span>
    </button>
  );
}
