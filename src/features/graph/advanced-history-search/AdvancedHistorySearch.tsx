import type { CommitNode } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { AdvancedHistorySearchForm } from "./AdvancedHistorySearchForm";
import { AdvancedHistorySearchResults } from "./AdvancedHistorySearchResults";
import { useAdvancedHistorySearch } from "./useAdvancedHistorySearch";

const EMPTY_COMMITS: CommitNode[] = [];

/** Thin store-connected controller. Stateful orchestration lives in the hook;
 * both rendered surfaces are prop-only. */
export function AdvancedHistorySearch() {
  const repoPath = useRepo((state) => state.summary?.path ?? null);
  const searchHistory = useRepo((state) => state.searchHistory);
  const suggestTreePaths = useRepo((state) => state.suggestTreePaths);
  const commits = useRepo((state) => state.graph?.commits);
  const branches = useRepo((state) => state.branches);
  const controller = useAdvancedHistorySearch({
    repoPath,
    searchHistory,
    suggestTreePaths,
    commits: commits ?? EMPTY_COMMITS,
    branches,
  });

  return (
    <div className="border-b border-black/5 bg-black/[0.015] px-4 py-3 dark:border-white/5 dark:bg-white/[0.02]">
      <AdvancedHistorySearchForm {...controller.form} />
      <AdvancedHistorySearchResults {...controller.results} />
    </div>
  );
}
