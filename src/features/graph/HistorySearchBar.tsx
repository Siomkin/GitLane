import { cn } from "../../lib/cn";
import { useUi, type HistFilter } from "../../store/ui";
import { CloseIcon, FilterIcon, SearchIcon } from "@/components/ui/icons";

const HIST_FILTERS: { key: HistFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "commits", label: "Commits" },
  { key: "merges", label: "Merges" },
  { key: "tags", label: "Tagged" },
];

/**
 * The commit-list header: a toggleable incremental search bar (with an inline
 * clear) and a "Show" kind-filter chip row, plus the results count. All
 * search/filter state lives in `useUi`; the parent passes only the derived
 * `countLabel` and the current `selectedCount` (for the multi-select badge).
 */
export function HistorySearchBar({
  countLabel,
  selectedCount,
}: {
  countLabel: string;
  selectedCount: number;
}) {
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

  return (
    <div className="shrink-0 border-b border-black/5 dark:border-white/5">
      <div className="flex h-12 items-center gap-2 px-4">
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
            onClick={toggleHistSearch}
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
      {histFilterOpen && (
        <div className="flex items-center gap-1.5 px-4 pb-2.5">
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
