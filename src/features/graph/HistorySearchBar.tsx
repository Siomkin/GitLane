import { useState } from "react";
import type { CommitNode } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useRepo } from "@/store/repo";
import { useUi, type HistFilter } from "@/store/ui";
import { CloseIcon, FilterIcon, HashIcon, SearchIcon } from "@/components/ui/icons";
import { AdvancedHistorySearch } from "./advanced-history-search";
import { SearchResultsList } from "./SearchResultsList";

const HIST_FILTERS: { key: HistFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "commits", label: "Commits" },
  { key: "merges", label: "Merges" },
  { key: "tags", label: "Tagged" },
];

/**
 * The commit-list header: a toggleable incremental search bar (with an inline
 * clear), a clickable results panel while a text query is active (so a match
 * is one click away instead of a scroll through the dimmed graph), and a
 * "Show" kind-filter chip row, plus the results count. All search/filter
 * state lives in `useUi`; the parent passes the derived `countLabel`, the
 * current `selectedCount` (for the multi-select badge), and `matches` — the
 * loaded commits matching the active text query (null while none is typed).
 */
export function HistorySearchBar({
  countLabel,
  selectedCount,
  matches,
}: {
  countLabel: string;
  selectedCount: number;
  matches: CommitNode[] | null;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [revealing, setRevealing] = useState<string | null>(null);
  const revealCommit = useRepo((s) => s.revealCommit);
  const histSearchOpen = useUi((s) => s.histSearchOpen);
  const histQuery = useUi((s) => s.histQuery);
  const histFilter = useUi((s) => s.histFilter);
  const histFilterOpen = useUi((s) => s.histFilterOpen);
  const toggleHistSearch = useUi((s) => s.toggleHistSearch);
  const setHistQuery = useUi((s) => s.setHistQuery);
  const clearHistQuery = useUi((s) => s.clearHistQuery);
  const toggleHistFilter = useUi((s) => s.toggleHistFilter);
  const setHistFilter = useUi((s) => s.setHistFilter);
  const filterActive = histFilterOpen || histFilter !== "all";
  // The quick results panel accompanies an active text query; kind-filter-only
  // narrowing keeps the highlight-in-place behaviour without a list.
  const quickResultsOpen = histSearchOpen && matches !== null;

  // Quick search (this graph) and repo-wide search are alternatives, not
  // layers — they were never meant to be open together, so opening one closes
  // the other (radio, not checkbox). The kind filter is orthogonal and can
  // coexist with either.
  const openQuickSearch = () => {
    if (!histSearchOpen && advancedOpen) setAdvancedOpen(false);
    toggleHistSearch();
  };
  const openAdvancedSearch = () => {
    const opening = !advancedOpen;
    setAdvancedOpen(opening);
    if (opening && histSearchOpen) toggleHistSearch();
  };

  // Quick-search hits come from the loaded graph, so revealing is a plain
  // scroll-to (no history paging, unlike the advanced search's reveal).
  const reveal = async (id: string) => {
    setRevealing(id);
    try {
      await revealCommit(id);
    } catch {
      // Best-effort scroll-to; a failed reveal (e.g. the commit left the graph
      // after a concurrent refresh) just leaves the selection put rather than
      // surfacing an error in this compact bar — and never rejects `void reveal`.
    } finally {
      setRevealing(null);
    }
  };

  return (
    <div className="shrink-0">
      {/* Border on the row itself (not an outer wrapper) so the collapsed header
          is exactly h-12 — matching the right panel / review headers to the
          pixel. When the results panel / filter chips open, the divider moves
          to the lowest open row. */}
      <div
        className={cn(
          "flex h-12 items-center gap-2 px-4",
          !quickResultsOpen && !histFilterOpen && !advancedOpen && "border-b border-black/5 dark:border-white/5",
        )}
      >
        {histSearchOpen ? (
          <>
            <SearchIcon className="h-4 w-4 shrink-0 text-neutral-400" />
            <input
              value={histQuery}
              onChange={(e) => setHistQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && toggleHistSearch()}
              autoFocus
              aria-label="Search commits"
              placeholder="Search message, SHA, author, branch…"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-neutral-800 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
            />
            <span className="shrink-0 whitespace-nowrap text-[11px] text-neutral-400">{countLabel}</span>
            {histQuery !== "" && (
              <button type="button"
                onClick={clearHistQuery}
                title="Clear search"
                aria-label="Clear search"
                className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5"
              >
                <CloseIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </>
        ) : (
          <>
            <span className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">Commits</span>
            <span className="whitespace-nowrap text-xs text-neutral-400">{countLabel}</span>
            {selectedCount > 1 ? (
              <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--accent)]">
                {selectedCount} selected
              </span>
            ) : (
              <span className="ml-3 truncate text-[11px] text-neutral-300 dark:text-neutral-600">
                drag a branch or tag onto any commit to move it
              </span>
            )}
          </>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1 text-neutral-400">
          <button type="button"
            onClick={openQuickSearch}
            title="Search commits"
            aria-label="Search commits"
            aria-pressed={histSearchOpen}
            className={cn(
              "grid h-7 w-7 place-items-center rounded-md transition-colors",
              histSearchOpen
                ? "bg-[var(--accent-soft)] text-[color:var(--accent)]"
                : "hover:bg-black/5 dark:hover:bg-white/5",
            )}
          >
            <SearchIcon className="h-4 w-4" />
          </button>
          <button type="button"
            onClick={openAdvancedSearch}
            title="Search entire repository"
            aria-label="Search entire repository"
            aria-pressed={advancedOpen}
            className={cn(
              "grid h-7 w-7 place-items-center rounded-md transition-colors",
              advancedOpen
                ? "bg-[var(--accent-soft)] text-[color:var(--accent)]"
                : "hover:bg-black/5 dark:hover:bg-white/5",
            )}
          >
            <HashIcon className="h-4 w-4" />
          </button>
          <button type="button"
            onClick={toggleHistFilter}
            title="Highlight commits by kind"
            aria-label="Highlight commits by kind"
            aria-pressed={filterActive}
            className={cn(
              "grid h-7 w-7 place-items-center rounded-md transition-colors",
              filterActive
                ? "bg-[var(--accent-soft)] text-[color:var(--accent)]"
                : "hover:bg-black/5 dark:hover:bg-white/5",
            )}
          >
            <FilterIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
      {quickResultsOpen && matches && (
        <div
          className={cn(
            "px-4 pb-2.5",
            !histFilterOpen && !advancedOpen && "border-b border-black/5 dark:border-white/5",
          )}
        >
          <SearchResultsList
            results={matches}
            onSelect={(id) => void reveal(id)}
            busyId={revealing}
          />
        </div>
      )}
      {histFilterOpen && (
        <div className={cn("flex items-center gap-1.5 px-4 pb-2.5", !advancedOpen && "border-b border-black/5 dark:border-white/5")}>
          <span className="mr-0.5 text-[11px] font-medium text-neutral-400">Highlight</span>
          {HIST_FILTERS.map((f) => (
            <FilterChip
              key={f.key}
              label={f.label}
              active={histFilter === f.key}
              onClick={() => setHistFilter(f.key)}
            />
          ))}
        </div>
      )}
      {advancedOpen && <AdvancedHistorySearch />}
    </div>
  );
}

/** A "Show" kind-filter pill — accent-filled when its filter is active. */
function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "h-6 rounded-full px-2.5 text-[11px] font-medium transition-colors",
        active
          ? "bg-[var(--accent)] text-white"
          : "bg-black/[0.04] text-neutral-500 hover:bg-black/[0.07] dark:bg-white/[0.06] dark:text-neutral-400 dark:hover:bg-white/10",
      )}
    >
      {label}
    </button>
  );
}
