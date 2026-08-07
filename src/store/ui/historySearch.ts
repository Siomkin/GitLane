// History-view incremental search + kind filter over the commit list.
import type { SliceSet } from "./slice";

/** Commit-list kind filter in the History view: everything, regular (non-merge)
 * commits, merges, or commits carrying a tag. */
export type HistFilter = "all" | "commits" | "merges" | "tags";

export interface HistorySearchSlice {
  /** Unlike the PR list's `prFilter`, none of this persists: the search bar
   * starts closed and unfiltered each session, and resets on a repo switch —
   * one repo's query must never land on another's commits. */
  histSearchOpen: boolean;
  histQuery: string;
  histFilter: HistFilter;
  histFilterOpen: boolean;

  /** Toggle the commit search bar; closing it clears the query. */
  toggleHistSearch: () => void;
  setHistQuery: (query: string) => void;
  /** Clear just the search query, keeping the bar open and the kind filter. */
  clearHistQuery: () => void;
  /** Toggle the "Show" kind-filter chip row. */
  toggleHistFilter: () => void;
  setHistFilter: (filter: HistFilter) => void;
  /** Reset both search query and kind filter to their inert state. */
  clearHistFilters: () => void;
}

/** The inert state, and what a repo switch restores. Declared as the reset so
 * the initial values and the switch behaviour cannot drift apart. */
export const resetHistorySearch = (): Pick<
  HistorySearchSlice,
  "histSearchOpen" | "histQuery" | "histFilter" | "histFilterOpen"
> => ({
  histSearchOpen: false,
  histQuery: "",
  histFilter: "all",
  histFilterOpen: false,
});

export function createHistorySearchSlice(set: SliceSet<HistorySearchSlice>): HistorySearchSlice {
  return {
    ...resetHistorySearch(),

    toggleHistSearch: () =>
      set((s) => ({
        histSearchOpen: !s.histSearchOpen,
        histQuery: s.histSearchOpen ? "" : s.histQuery,
      })),
    setHistQuery: (query) => set({ histQuery: query }),
    clearHistQuery: () => set((s) => (s.histQuery === "" ? s : { histQuery: "" })),
    toggleHistFilter: () => set((s) => ({ histFilterOpen: !s.histFilterOpen })),
    setHistFilter: (filter) => set({ histFilter: filter }),
    clearHistFilters: () =>
      set((s) =>
        s.histQuery === "" && s.histFilter === "all" ? s : { histQuery: "", histFilter: "all" },
      ),
  };
}
