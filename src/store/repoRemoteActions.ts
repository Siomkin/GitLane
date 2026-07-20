// Remote read + mutations for the Repository settings → Remotes panel and the
// per-remote account bindings (GL-129). The calls live here so the IPC boundary
// stays in one place — a component never imports `api` to invent a second data
// path (architecture-rules-react.md §1). The read publishes the list into the
// store's `remotes` slice (the panel and account resolution share it) and
// re-resolves the per-remote bindings, since which accounts apply depends on
// the remote list; the mutations stay thin (`git remote add/set-url/remove` via
// the real CLI) and leave the post-write reload + repo `refresh` to the caller,
// which generation-guards them against a repo switch landing mid-await.

import { api, type RemoteInfo } from "@/lib/api";
import { useAccounts } from "./accounts";
import { usePulls } from "./pulls";
import { remotesRequestIsCurrent } from "./repoGuards";
import {
  beginRemotesRequest,
  claimPrPrefetch,
  currentPublishedRepoSession,
  markRemotesReadyForPr,
  requestPrPrefetch,
} from "./repoRequests";
import type { RepoGet, RepoSet, RepoState } from "./repoTypes";

export function createRepoRemoteActions(
  set: RepoSet,
  get: RepoGet,
): Pick<RepoState, "listRemotes" | "addRemote" | "setRemoteUrl" | "removeRemote"> {
  // Resolve the open repo's path or throw — the panel only calls these with a
  // repo open, mirroring the `No repository` guard the write actions use.
  const repoPath = (): string => {
    const { summary } = get();
    if (!summary) throw new Error("No repository");
    return summary.path;
  };
  // `async` so the `repoPath()` guard surfaces as a rejected promise, not a
  // synchronous throw — matching every other store action (callers `await` these
  // inside a try/catch).
  return {
    listRemotes: async () => {
      const path = repoPath();
      const owner = {
        path,
        session: currentPublishedRepoSession(),
        generation: beginRemotesRequest(),
      };
      let remotes: RemoteInfo[];
      try {
        remotes = await api.listRemotes(path);
      } catch (error) {
        // A superseded read no longer owns even its error. Resolve to the
        // currently published slice so UI callers cannot flash a stale failure
        // while the newer lane is still completing.
        if (!remotesRequestIsCurrent(get, owner)) return get().remotes;
        throw error;
      }
      // Latest-started wins inside the current published repo session. The
      // session closes the same-path close/reopen hole; the lane token also
      // prevents a slow manual reload from overwriting a newer full refresh.
      if (remotesRequestIsCurrent(get, owner)) {
        set({ remotes });
        useAccounts.getState().syncRepoAccount(path);
        requestPrPrefetch(owner.session);
        markRemotesReadyForPr(owner.session, owner.generation);
        if (claimPrPrefetch(owner.session)) {
          void usePulls.getState().loadPullRequests(false, true);
        }
        return remotes;
      }
      return get().remotes;
    },
    addRemote: async (name, url) => api.addRemote(repoPath(), name, url),
    setRemoteUrl: async (name, url) => api.setRemoteUrl(repoPath(), name, url),
    removeRemote: async (name) => api.removeRemote(repoPath(), name),
  };
}
