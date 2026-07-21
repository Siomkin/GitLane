import type { HistorySearchPage } from "@/lib/api";
import { SearchResultsList } from "@/features/graph/SearchResultsList";

export interface AdvancedHistorySearchResultsProps {
  error: string | null;
  page: HistorySearchPage | null;
  revealing: string | null;
  onReveal: (id: string) => void;
}

export function AdvancedHistorySearchResults({
  error,
  page,
  revealing,
  onReveal,
}: AdvancedHistorySearchResultsProps) {
  return (
    <>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {page && (
        <div className="mt-3">
          <SearchResultsList
            results={page.results}
            onSelect={onReveal}
            busyId={revealing}
            truncated={page.truncated}
            truncatedLabel={
              page.workTruncated
                ? "Showing partial results — narrow the revision or date range."
                : "Showing the first 200 matches."
            }
            emptyLabel={page.workTruncated ? "No matches in the scanned history." : undefined}
          />
        </div>
      )}
    </>
  );
}
