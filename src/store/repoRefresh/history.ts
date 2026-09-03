// Paging further back through the commit graph, and the reflog behind the
// recovery UI. Both are reads that extend what the last refresh published
// rather than re-taking it, so they claim their own request generation and
// leave the rest of the store alone.

import { api } from "@/lib/api";
import { graphRequestIsCurrent, readRequestIsCurrent } from "@/store/repoGuards";
import { graphRequests, publishedRepoSession, reflogRequests } from "@/store/repoRequests";
import { useUi } from "@/store/ui";
import { GRAPH_PAGE_SIZE, type RepoGet, type RepoSet, type RepoState } from "@/store/repoTypes";

export function createRepoHistoryPaging(
  set: RepoSet,
  get: RepoGet,
): Pick<RepoState, "loadMoreHistory" | "loadReflog"> {
  return {
  loadMoreHistory: async () => {
    const { summary, graph, graphLimit, loading, loadingMoreHistory } = get();
    if (!summary || !graph?.truncated || loading || loadingMoreHistory) return;
    const nextLimit = graphLimit + GRAPH_PAGE_SIZE;
    const generation = graphRequests.claim();
    set({ loadingMoreHistory: true, loading: false });
    try {
      const nextGraph = await api.commitGraph(summary.path, nextLimit);
      if (!graphRequestIsCurrent(get, generation, summary.path)) return;
      set({
        graph: nextGraph,
        graphLimit: nextLimit,
        loadingMoreHistory: false,
      });
    } catch (error) {
      if (!graphRequestIsCurrent(get, generation, summary.path)) return;
      set({ loadingMoreHistory: false });
      useUi.getState().showToast(error, "error");
    }
  },

  loadReflog: async () => {
    const { summary } = get();
    if (!summary) return;
    const owner = {
      path: summary.path,
      session: publishedRepoSession.current(),
      generation: reflogRequests.claim(),
    };
    set({ reflogLoading: true, reflogError: null });
    try {
      const reflogEntries = await api.listReflog(summary.path, 120);
      if (!readRequestIsCurrent(get, reflogRequests, owner)) return;
      set({ reflogEntries, reflogLoading: false });
    } catch (e) {
      if (!readRequestIsCurrent(get, reflogRequests, owner)) return;
      set({ reflogLoading: false, reflogError: String(e) });
    }
  },
  };
}
